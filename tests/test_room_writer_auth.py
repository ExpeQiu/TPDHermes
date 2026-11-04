"""房间主笔请求必须带上 Hermes Bearer，否则 HTTP 上游返回 401。"""

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
async def test_writer_sends_bearer_when_key_configured(monkeypatch):
    monkeypatch.setenv("HERMES_CHAT_API_URL", "http://hermes-agent:8642/v1/chat/completions")
    monkeypatch.setenv("HERMES_CHAT_API_KEY", "test-key")
    monkeypatch.setattr("backend.services.room_writer.httpx.AsyncClient", _Client)
    text = await request_writer_completion([{"role": "user", "content": "hi"}])
    assert text == "你好"
    assert _Client.captured["headers"]["Authorization"] == "Bearer test-key"
    assert _Client.captured["client"]["trust_env"] is False


@pytest.mark.asyncio
async def test_writer_omits_auth_header_without_key(monkeypatch):
    monkeypatch.setenv("HERMES_CHAT_API_URL", "http://hermes-agent:8642/v1/chat/completions")
    monkeypatch.delenv("HERMES_CHAT_API_KEY", raising=False)
    monkeypatch.setattr("backend.services.room_writer.httpx.AsyncClient", _Client)
    await request_writer_completion([{"role": "user", "content": "hi"}])
    assert "Authorization" not in _Client.captured["headers"]
