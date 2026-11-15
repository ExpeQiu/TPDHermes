"""房间主笔请求必须带上 Hermes Bearer，否则 HTTP 上游返回 401。"""

import json
from pathlib import Path

import pytest

from backend.services.room_writer import request_writer_completion


class _Response:
    def __init__(self, status_code: int, payload: dict | None = None):
        self.status_code = status_code
        self._payload = payload or {}

    def json(self):
        return self._payload


class _Client:
    captured: dict = {}

    def __init__(self, **kwargs):
        _Client.captured["client"] = kwargs

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def post(self, url, json=None, headers=None):
        _Client.captured["url"] = url
        _Client.captured["headers"] = headers
        return _Response(200, {"choices": [{"message": {"content": "你好"}}]})


@pytest.mark.asyncio
async def test_writer_sends_bearer_when_key_configured(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("TPDHERMES_KERNEL_BINDING_PATH", str(tmp_path / "missing.json"))
    monkeypatch.setenv("HERMES_CHAT_API_URL", "http://hermes-agent:8642/v1/chat/completions")
    monkeypatch.setenv("HERMES_CHAT_API_KEY", "test-key")
    monkeypatch.setattr("backend.services.room_writer.httpx.AsyncClient", _Client)
    text = await request_writer_completion([{"role": "user", "content": "hi"}])
    assert text == "你好"
    assert _Client.captured["headers"]["Authorization"] == "Bearer test-key"
    assert _Client.captured["client"]["trust_env"] is False


@pytest.mark.asyncio
async def test_writer_uses_bound_gateway_key_over_placeholder(monkeypatch, tmp_path: Path):
    root = tmp_path / "hermes-home"
    root.mkdir()
    (root / ".env").write_text(
        "API_SERVER_KEY=gateway-key-from-kernel\nAPI_SERVER_PORT=8642\n",
        encoding="utf-8",
    )
    binding = tmp_path / "binding.json"
    binding.write_text(
        json.dumps({"kernel_id": "hermes-agent", "root": str(root)}),
        encoding="utf-8",
    )
    monkeypatch.setenv("TPDHERMES_KERNEL_BINDING_PATH", str(binding))
    monkeypatch.setenv("HERMES_CHAT_API_URL", "http://127.0.0.1:8642/v1/chat/completions")
    monkeypatch.setenv("HERMES_CHAT_API_KEY", "test-key")
    monkeypatch.setattr("backend.services.room_writer.httpx.AsyncClient", _Client)
    await request_writer_completion([{"role": "user", "content": "hi"}])
    assert _Client.captured["url"] == "http://127.0.0.1:8642/v1/chat/completions"
    assert _Client.captured["headers"]["Authorization"] == "Bearer gateway-key-from-kernel"


@pytest.mark.asyncio
async def test_writer_omits_auth_header_without_key(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("TPDHERMES_KERNEL_BINDING_PATH", str(tmp_path / "missing.json"))
    monkeypatch.setenv("HERMES_CHAT_API_URL", "http://hermes-agent:8642/v1/chat/completions")
    monkeypatch.delenv("HERMES_CHAT_API_KEY", raising=False)
    monkeypatch.setattr("backend.services.room_writer.httpx.AsyncClient", _Client)
    await request_writer_completion([{"role": "user", "content": "hi"}])
    assert "Authorization" not in _Client.captured["headers"]
