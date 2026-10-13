"""三方 MCP 预留：已保存地址不被环境变量盖回。"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from backend import app
from backend.services.external_mcp import probe_external_mcp, resolve_external_mcp, save_external_mcp


def _isolate(monkeypatch, tmp_path):
    monkeypatch.setenv("TPDHERMES_EXTERNAL_MCP_CONFIG", str(tmp_path / "external-mcp.json"))
    monkeypatch.delenv("AUTOCAR_MCP_URL", raising=False)


def _autocar(payload):
    return next(row for row in payload["providers"] if row["id"] == "autocar")


def test_reserved_until_url_saved(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)
    row = _autocar(resolve_external_mcp())
    assert row["site"] == "https://autocar.aiforworld.cn/"
    assert row["mcp_url"] == ""
    assert row["status"] == "reserved"
    assert row["mcp_url_source"] == "default"


def test_saved_empty_url_blocks_env(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)
    save_external_mcp("autocar", mcp_url="")
    monkeypatch.setenv("AUTOCAR_MCP_URL", "http://127.0.0.1:9/mcp")
    row = _autocar(resolve_external_mcp())
    assert row["mcp_url"] == ""
    assert row["mcp_url_source"] == "saved"
    assert row["status"] == "reserved"


def test_saved_url_wins_over_later_env(monkeypatch, tmp_path):
    path = tmp_path / "external-mcp.json"
    path.write_text(
        json.dumps({"providers": {"autocar": {"mcp_url": "https://mcp.example/autocar"}}}),
        encoding="utf-8",
    )
    monkeypatch.setenv("TPDHERMES_EXTERNAL_MCP_CONFIG", str(path))
    monkeypatch.setenv("AUTOCAR_MCP_URL", "http://127.0.0.1:9/overwrite")
    row = _autocar(resolve_external_mcp())
    assert row["mcp_url"] == "https://mcp.example/autocar"
    assert row["status"] == "configured"
    assert row["mcp_url_source"] == "saved"


def test_probe_without_url_stays_reserved(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)
    result = probe_external_mcp("autocar", mcp_url="")
    assert result["ok"] is False
    assert result["reserved"] is True
    assert not (tmp_path / "external-mcp.json").exists()


def test_external_mcp_route_roundtrip(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)
    with TestClient(app) as client:
        saved = client.put("/api/v1/system/external-mcp/autocar", json={"mcp_url": ""})
        assert saved.status_code == 200
        monkeypatch.setenv("AUTOCAR_MCP_URL", "http://127.0.0.1:9/overwrite")
        again = client.get("/api/v1/system/external-mcp")
    assert again.status_code == 200
    row = _autocar(again.json())
    assert row["site"] == "https://autocar.aiforworld.cn/"
    assert row["mcp_url"] == ""
    assert row["mcp_url_source"] == "saved"
