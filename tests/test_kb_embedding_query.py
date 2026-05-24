"""KB 本地 embedding 查询与重排。"""

import pytest

from backend.services.kb_embedding import (
    cosine_scores,
    extract_searchable_text,
)
from backend.services.kb_proxy import KBProxyService


def test_extract_searchable_text_strips_images():
    doc = "标题\n![img](http://x/a.png)\nGEA 架构说明"
    text = extract_searchable_text(doc, {"title": "GEA"})
    assert "GEA" in text
    assert "http://x" not in text


def test_cosine_scores_normalized():
    q = [1.0, 0.0]
    docs = [[1.0, 0.0], [0.0, 1.0]]
    scores = cosine_scores(q, docs)
    assert scores[0] > scores[1]


@pytest.mark.asyncio
async def test_build_chroma_query_payload_uses_embeddings(monkeypatch):
    async def fake_embed(texts):
        return [[0.1, 0.2, 0.3]]

    monkeypatch.setattr("backend.services.kb_proxy.embed_enabled", lambda: True)
    monkeypatch.setattr("backend.services.kb_proxy.embed_query_texts", fake_embed)

    svc = KBProxyService(chroma_host="http://chroma")
    payload = await svc._build_chroma_query_payload("GEA", 3)
    assert "query_embeddings" in payload
    assert payload["query_embeddings"] == [[0.1, 0.2, 0.3]]


@pytest.mark.asyncio
async def test_semantic_empty_uses_local_embed_rank(monkeypatch):
    svc = KBProxyService(chroma_host="http://chroma-test")
    monkeypatch.setattr("backend.services.kb_proxy.embed_enabled", lambda: True)

    async def chroma_hit(_self, _client, _ref, _name, _q, _n):
        return {
            "results": [{"content": "GEA 说明", "metadata": {}, "distance": 0.1}],
            "source": "chroma",
            "count": 1,
            "warning": "local_embed_rank_fallback",
        }

    monkeypatch.setattr(KBProxyService, "_query_collection_on_chroma", chroma_hit)

    out = await svc.query_collection("public.structured_tech.geely_tech", "GEA", n_results=3)
    assert out["count"] == 1
    assert "local_embed_rank_fallback" in (out.get("warning") or "")


@pytest.mark.asyncio
async def test_semantic_empty_then_contains_fallback(monkeypatch):
    svc = KBProxyService(chroma_host="http://chroma-test")
    monkeypatch.setattr("backend.services.kb_proxy.embed_enabled", lambda: False)

    async def resolve(self, _name, client=None):
        return "col-id"

    async def empty_semantic(self, *_a, **_k):
        return {"results": [], "source": "chroma", "count": 0}

    async def via_get(self, **_kwargs):
        return {
            "results": [{"content": "命中", "metadata": {}, "distance": 0.0}],
            "source": "chroma",
            "count": 1,
        }

    async def empty_cache(**_k):
        return []

    monkeypatch.setattr(KBProxyService, "_resolve_collection_ref", resolve)
    monkeypatch.setattr(KBProxyService, "_post_chroma_query", empty_semantic)
    monkeypatch.setattr(KBProxyService, "_query_collection_via_get", via_get)
    monkeypatch.setattr(
        "backend.services.kb_proxy.kb_cache_service.get_cached_entries",
        empty_cache,
    )

    out = await svc.query_collection("public.structured_tech.geely_tech", "GEA", n_results=3)
    assert out["count"] == 1
    assert out["source"] == "chroma"
    assert "semantic_empty_used_contains_fallback" in (out.get("warning") or "")
