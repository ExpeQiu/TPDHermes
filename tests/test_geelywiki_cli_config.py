"""GeelyWiki MCP 配置：已保存地址不被环境变量盖回。"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from backend import app
from backend.services.geelywiki_cli_config import probe_wiki_mcp, resolve_wiki_mcp, save_wiki_mcp
from backend.services.geelywiki_mcp import fetch_pages_via_mcp


def _isolate(monkeypatch, tmp_path):
    monkeypatch.setenv("TPDHERMES_GEELYWIKI_MCP_CONFIG", str(tmp_path / "geelywiki-mcp.json"))
    monkeypatch.delenv("GEELYWIKI_MCP_URL", raising=False)


def test_missing_file_falls_back_to_env(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)
    monkeypatch.setenv("GEELYWIKI_MCP_URL", "http://127.0.0.1:9/mcp")

    payload = resolve_wiki_mcp()

    assert payload["url"] == "http://127.0.0.1:9/mcp"
    assert payload["url_source"] == "env"
    assert payload["config_exists"] is False


def test_saved_url_wins_over_later_env(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)
    save_wiki_mcp(url="http://127.0.0.1:8787/mcp")
    monkeypatch.setenv("GEELYWIKI_MCP_URL", "http://127.0.0.1:9/should-not-apply")

    payload = resolve_wiki_mcp()

    assert payload["url"] == "http://127.0.0.1:8787/mcp"
    assert payload["url_source"] == "saved"


def test_empty_saved_url_does_not_pick_up_env(monkeypatch, tmp_path):
    path = tmp_path / "geelywiki-mcp.json"
    path.write_text(json.dumps({"url": ""}), encoding="utf-8")
    monkeypatch.setenv("TPDHERMES_GEELYWIKI_MCP_CONFIG", str(path))
    monkeypatch.setenv("GEELYWIKI_MCP_URL", "http://127.0.0.1:9/should-not-apply")

    payload = resolve_wiki_mcp()

    assert payload["url"] == ""
    assert payload["url_source"] == "saved"


def test_probe_pages_list_uses_form_url(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)
    seen: dict[str, object] = {}

    def fake_call(url, name, arguments=None, timeout=30):
        seen["url"] = url
        seen["name"] = name
        return {"module": "pages-list", "items": [{"slug": "a"}, {"slug": "b"}]}

    monkeypatch.setattr("backend.services.geelywiki_mcp.call_wiki_tool", fake_call)
    result = probe_wiki_mcp(url="http://wiki.local/mcp")

    assert result["ok"] is True
    assert result["count"] == 2
    assert seen["url"] == "http://wiki.local/mcp"
    assert seen["name"] == "pages_list"
    assert not (tmp_path / "geelywiki-mcp.json").exists()


def test_fetch_export_then_stop(monkeypatch):
    calls: list[str] = []

    def fake_call(url, name, arguments=None, timeout=30):
        calls.append(name)
        return {
            "module": "pages-export",
            "data_source": "live",
            "publish_scope": "internal",
            "pages": [{"slug": "a", "body": "正文", "claims": []}],
        }

    monkeypatch.setattr("backend.services.geelywiki_mcp.call_wiki_tool", fake_call)
    payload = fetch_pages_via_mcp(url="http://wiki.local/mcp")

    assert calls == ["pages_export"]
    assert payload["pages"][0]["slug"] == "a"


def test_wiki_mcp_route_roundtrip(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)
    with TestClient(app) as client:
        saved = client.put("/api/v1/system/wiki-mcp", json={"url": "http://127.0.0.1:8787/mcp"})
        assert saved.status_code == 200
        monkeypatch.setenv("GEELYWIKI_MCP_URL", "http://127.0.0.1:9/overwrite")
        again = client.get("/api/v1/system/wiki-mcp")
    assert again.status_code == 200
    body = again.json()
    assert body["url"] == "http://127.0.0.1:8787/mcp"
    assert body["url_source"] == "saved"
