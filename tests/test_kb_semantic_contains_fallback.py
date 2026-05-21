"""语义检索空结果时 $contains 回退。"""

import pytest

from backend.services.kb_proxy import KBProxyService


@pytest.mark.asyncio
async def test_semantic_empty_triggers_contains_fallback(monkeypatch):
    svc = KBProxyService(chroma_host="http://chroma-test")

    async def resolve(_name: str) -> str:
        return "col-id-1"

    async def via_get(**_kwargs):
        return {
            "results": [{"content": "GEA 架构说明", "metadata": {}, "distance": 0.0}],
            "source": "chroma",
            "count": 1,
        }

    class FakeResp:
        status_code = 200

        def json(self):
            return {"documents": [[]], "metadatas": [[]], "distances": [[]]}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, url, json=None):
            return FakeResp()

    monkeypatch.setattr(svc, "_resolve_collection_ref", resolve)
    monkeypatch.setattr(svc, "_query_collection_via_get", via_get)
    monkeypatch.setattr("backend.services.kb_proxy.httpx.AsyncClient", lambda **kw: FakeClient())

    out = await svc.query_collection("public.structured_tech.geely_tech", "GEA", n_results=3)
    assert out["count"] == 1
    assert "semantic_empty_used_contains_fallback" in (out.get("warning") or "")
