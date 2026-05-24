"""KB 查询性能优化：并行、ref 缓存、降级链、doc 向量缓存。"""

import asyncio
import time

import pytest

from backend.services.kb_proxy import KBProxyService


def test_build_ref_map_name_and_id():
    data = [
        {"name": "public.a", "id": "uuid-1"},
        {"name": "public.b", "id": "uuid-2"},
    ]
    m = KBProxyService._build_ref_map_from_list(data)
    assert m["public.a"] == "uuid-1"
    assert m["uuid-1"] == "uuid-1"


@pytest.mark.asyncio
async def test_ref_map_cached(monkeypatch):
    svc = KBProxyService(chroma_host="http://chroma-test")
    calls = {"n": 0}

    async def fake_fetch(_client=None):
        now = time.monotonic()
        if svc._ref_map_cache and now - svc._ref_map_cache[0] < 60:
            return svc._ref_map_cache[1]
        calls["n"] += 1
        ref_map = {"col-a": "ref-a"}
        svc._ref_map_cache = (now, ref_map)
        return ref_map

    monkeypatch.setattr(svc, "_fetch_collection_ref_map", fake_fetch)
    r1 = await svc._resolve_collection_ref("col-a")
    r2 = await svc._resolve_collection_ref("col-a")
    assert r1 == "ref-a"
    assert r2 == "ref-a"
    assert calls["n"] == 1


@pytest.mark.asyncio
async def test_local_embed_skips_keyword_when_scanned(monkeypatch):
    svc = KBProxyService(chroma_host="http://chroma-test")
    monkeypatch.setattr("backend.services.kb_proxy.embed_enabled", lambda: True)

    async def resolve(_self, _name, client=None):
        return "ref"

    async def empty_semantic(_self, *_a, **_k):
        return {"results": [], "source": "chroma", "count": 0}

    async def local_empty(_self, *_a, **_k):
        return build_empty_local()

    async def should_not_call_get(**_k):
        raise AssertionError("keyword fallback should be skipped")

    monkeypatch.setattr(KBProxyService, "_resolve_collection_ref", resolve)
    monkeypatch.setattr(KBProxyService, "_post_chroma_query", empty_semantic)
    monkeypatch.setattr(KBProxyService, "_query_collection_via_local_embed", local_empty)
    monkeypatch.setattr(KBProxyService, "_query_collection_via_get", should_not_call_get)

    async with __import__("httpx").AsyncClient(timeout=5.0) as client:
        out = await svc._query_collection_on_chroma(
            client, "ref", "col", "GEA", 3
        )
    assert out is not None
    assert out.get("count", 0) == 0


def build_empty_local():
    from backend.services.kb_chroma_query import build_query_result

    return build_query_result(
        [],
        source="chroma",
        warning="local_embed_rank_fallback",
    )


@pytest.mark.asyncio
async def test_query_all_parallel(monkeypatch):
    svc = KBProxyService(chroma_host="http://chroma-test")
    active = {"n": 0}
    lock = asyncio.Lock()

    async def list_cols(**_k):
        return {"collections": ["c1", "c2", "c3"], "source": "chroma"}

    async def fetch_map(_client=None):
        return {"c1": "r1", "c2": "r2", "c3": "r3"}

    async def query_one(_client, ref, name, _q, _n):
        async with lock:
            active["n"] += 1
            peak = active["n"]
            await asyncio.sleep(0.05)
            active["n"] -= 1
        return {
            "results": [{"content": name, "metadata": {}, "distance": 0.1}],
            "source": "chroma",
            "count": 1,
        }

    monkeypatch.setattr(svc, "list_collections", list_cols)
    monkeypatch.setattr(svc, "_fetch_collection_ref_map", fetch_map)
    monkeypatch.setattr(svc, "_query_collection_on_chroma", query_one)

    t0 = time.monotonic()
    out = await svc.query_all_collections("q", n_results=5)
    elapsed = time.monotonic() - t0

    assert out["count"] == 3
    assert elapsed < 0.22  # 串行约 0.15×3，并行应接近单次 sleep


@pytest.mark.asyncio
async def test_local_rank_doc_vector_cache(monkeypatch):
    svc = KBProxyService(chroma_host="http://chroma-test")
    encode_calls = {"n": 0}

    async def fake_fetch(_ref, *, limit, client=None):
        return [("doc1", {"title": "T"})]

    def fake_embed(texts):
        encode_calls["n"] += 1
        return [[1.0, 0.0] for _ in texts]

    monkeypatch.setattr(svc, "_fetch_collection_documents", fake_fetch)
    monkeypatch.setattr("backend.services.kb_proxy.embed_texts_sync", fake_embed)
    monkeypatch.setattr("backend.services.kb_proxy.embed_enabled", lambda: True)

    idx1 = await svc._get_local_rank_index("ref", limit=100)
    idx2 = await svc._get_local_rank_index("ref", limit=100)
    assert idx1 is not None and idx2 is not None
    assert encode_calls["n"] == 1
