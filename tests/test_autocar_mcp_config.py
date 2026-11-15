"""Autocar Wiki MCP：已保存地址不被环境变量盖回，同步写入独立集合。"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from backend import app
from backend.services.autocar_cli_config import resolve_autocar_mcp, save_autocar_mcp
from backend.services.kb_contract import autocar_import_target


def _isolate(monkeypatch, tmp_path):
    monkeypatch.setenv("TPDHERMES_AUTOCAR_MCP_CONFIG", str(tmp_path / "autocar-mcp.json"))
    monkeypatch.delenv("AUTOCAR_MCP_URL", raising=False)
    monkeypatch.delenv("AUTOCAR_WIKI_ROOT", raising=False)


def test_default_points_at_autocar_checkout(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)
    payload = resolve_autocar_mcp()
    assert payload["url"] == "http://127.0.0.1:8788/mcp"
    assert payload["root"] == "/Volumes/Lexar/git/03T/Aiforworld/Autocar-Wiki"
    assert payload["import_scope"] == "external"
    assert payload["url_source"] == "default"


def test_saved_url_and_root_win_over_env(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)
    save_autocar_mcp(
        url="http://127.0.0.1:8788/mcp",
        root="/Volumes/Lexar/git/03T/Aiforworld/Autocar-Wiki",
        import_scope="external",
    )
    monkeypatch.setenv("AUTOCAR_MCP_URL", "http://127.0.0.1:9/should-not-apply")
    monkeypatch.setenv("AUTOCAR_WIKI_ROOT", "/tmp/other")

    payload = resolve_autocar_mcp()

    assert payload["url"] == "http://127.0.0.1:8788/mcp"
    assert payload["root"] == "/Volumes/Lexar/git/03T/Aiforworld/Autocar-Wiki"
    assert payload["url_source"] == "saved"
    assert payload["root_source"] == "saved"


def test_empty_saved_root_does_not_pick_up_env(monkeypatch, tmp_path):
    path = tmp_path / "autocar-mcp.json"
    path.write_text(json.dumps({"url": "http://127.0.0.1:8788/mcp", "root": ""}), encoding="utf-8")
    monkeypatch.setenv("TPDHERMES_AUTOCAR_MCP_CONFIG", str(path))
    monkeypatch.setenv("AUTOCAR_WIKI_ROOT", "/tmp/other")

    payload = resolve_autocar_mcp()

    assert payload["root"] == ""
    assert payload["root_source"] == "saved"


def test_import_target_stays_off_geelywiki():
    internal, _authority = autocar_import_target("internal")
    external, _authority = autocar_import_target("external")
    assert internal == "internal.autocar.pages"
    assert external == "public.autocar.pages"


def test_autocar_sync_route(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)

    def fake_ingest(**kwargs):
        assert kwargs["apply"] is True
        assert kwargs["import_scope"] == "external"
        return {
            "ok": True,
            "page_count": 4,
            "doc_count": 4,
            "source": "mcp:live",
            "import_scope": "external",
            "collection": "public.autocar.pages",
            "graph_skipped": True,
        }

    async def admin_role(*_args, **_kwargs):
        return "platform_admin"

    monkeypatch.setattr("backend.services.rbac.resolve_platform_role", admin_role)
    monkeypatch.setattr("backend.services.autocar_ingest.ingest_autocar", fake_ingest)

    with TestClient(app) as client:
        response = client.post(
            "/api/v1/kb/autocar/sync",
            json={"import_scope": "external"},
            headers={"X-User-ID": "default"},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["collection"] == "public.autocar.pages"
    assert body["graph_skipped"] is True
