"""知识库手动同步：走已保存的 GeelyWiki MCP，不在请求里改地址。"""

from fastapi.testclient import TestClient

from backend import app


def test_manual_sync_uses_mcp_and_hides_bundle(monkeypatch, tmp_path):
    monkeypatch.setenv("TPDHERMES_GEELYWIKI_MCP_CONFIG", str(tmp_path / "geelywiki-mcp.json"))
    def fake_ingest(**kwargs):
        assert kwargs["from_cli"] is True
        assert kwargs["apply"] is True
        assert kwargs["demo"] is False
        assert kwargs["import_scope"] == "external"
        return {
            "ok": True,
            "build_id": "20261110T000000Z",
            "page_count": 2,
            "doc_count": 3,
            "source": "mcp:live",
            "import_scope": "external",
            "collection": "public.geelywiki.pages",
            "kg_bundle": {"vehicles": [{"id": "v1"}], "relations": []},
        }

    async def fake_graph(bundle):
        assert len(bundle["vehicles"]) == 1
        return {"vehicles": 1}

    async def admin_role(*_args, **_kwargs):
        return "platform_admin"

    monkeypatch.setattr("backend.services.rbac.resolve_platform_role", admin_role)
    monkeypatch.setattr("backend.services.geelywiki_ingest.ingest_geelywiki", fake_ingest)
    monkeypatch.setattr("backend.services.geelywiki_ingest.apply_geelywiki_graph", fake_graph)

    with TestClient(app) as client:
        response = client.post(
            "/api/v1/kb/geelywiki/sync",
            json={"import_scope": "external"},
            headers={"X-User-ID": "default"},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["page_count"] == 2
    assert body["kg_counts"]["vehicles"] == 1
    assert "kg_bundle" not in body
    assert body["collection"] == "public.geelywiki.pages"
    assert body["graph_skipped"] is True
    assert "kg" not in body
