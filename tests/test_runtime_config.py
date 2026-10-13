"""运行配置快照：不含密钥，字段稳定。"""

import os

from fastapi.testclient import TestClient

from backend import app
from backend.services.runtime_config import build_runtime_config


def test_snapshot_omits_secrets(monkeypatch, tmp_path):
    monkeypatch.setenv("TPDHERMES_GEELYWIKI_MCP_CONFIG", str(tmp_path / "absent-geelywiki-mcp.json"))
    monkeypatch.setenv("HERMES_CHAT_API_URL", "http://user:secret@127.0.0.1:8642/v1/chat/completions")
    monkeypatch.setenv("HERMES_CHAT_API_KEY", "sk-should-not-leak")
    monkeypatch.setenv("HERMES_CHAT_MODEL", "hermes-agent")
    monkeypatch.setenv("AI_MOCK_MODE", "true")

    payload = build_runtime_config()
    blob = str(payload)

    assert payload["module"] == "system-config"
    assert payload["data_source"] == "env"
    assert payload["mock_mode"] is True
    assert payload["chat"]["available"] is True
    assert payload["chat"]["target"] == "http://127.0.0.1:8642/v1/chat/completions"
    assert "sk-should-not-leak" not in blob
    assert "secret" not in blob
    assert "wiki" in payload and payload["wiki"]["url"]


def test_system_config_route():
    with TestClient(app) as client:
        response = client.get("/api/v1/system/config")
    assert response.status_code == 200
    body = response.json()
    assert body["module"] == "system-config"
    assert "api_key" not in body
    key = os.getenv("HERMES_CHAT_API_KEY", "").strip()
    if key:
        assert key not in response.text
