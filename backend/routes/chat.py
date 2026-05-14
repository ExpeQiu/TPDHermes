"""
聊天代理路由：统一由 TPDHermes 后端承接，再转发到 Hermes-agent。
"""

from __future__ import annotations

import os
import json
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict

router = APIRouter(prefix="/chat", tags=["chat"])


class ChatMessage(BaseModel):
    role: str
    content: Any


class ChatCompletionRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    model: str = "hermes-agent"
    messages: list[ChatMessage]
    stream: bool = True


def _chat_target() -> tuple[str, str]:
    url = os.getenv("HERMES_CHAT_API_URL", "http://localhost:8642/v1/chat/completions").strip()
    api_key = os.getenv("HERMES_CHAT_API_KEY", "").strip()
    return url, api_key


def _chat_client(timeout: httpx.Timeout) -> httpx.AsyncClient:
    # Local upstreams such as localhost:8642 should bypass ambient proxy settings.
    return httpx.AsyncClient(timeout=timeout, trust_env=False)


def _format_upstream_error(status_code: int, detail: bytes) -> dict[str, Any]:
    if detail:
        try:
            parsed = json.loads(detail.decode("utf-8", errors="ignore"))
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            return parsed

    return {
        "error": {
            "message": f"Hermes-agent upstream error (HTTP {status_code})",
            "code": f"http_{status_code}",
        }
    }


@router.get("/config")
async def chat_config() -> dict[str, Any]:
    """返回当前聊天代理的最小配置信息，供前端展示链路状态。"""
    url, _api_key = _chat_target()
    return {
        "mode": "backend-proxy",
        "target": url,
        "model": os.getenv("HERMES_CHAT_MODEL", "hermes-agent"),
    }


@router.post("/completions")
async def chat_completions(request: ChatCompletionRequest):
    """代理 OpenAI 兼容聊天补全请求到 Hermes-agent。"""
    target_url, api_key = _chat_target()
    payload = request.model_dump(exclude_none=True)
    payload.setdefault("model", os.getenv("HERMES_CHAT_MODEL", "hermes-agent"))

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    timeout = httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=10.0)

    if not payload.get("stream", True):
        try:
            async with _chat_client(timeout) as client:
                resp = await client.post(target_url, headers=headers, json=payload)
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"Hermes-agent unavailable: {exc}") from exc

        return JSONResponse(
            status_code=resp.status_code,
            content=_format_upstream_error(resp.status_code, resp.content),
            headers={k: v for k, v in resp.headers.items() if k.lower() in {"content-type"}},
        )

    async def event_stream():
        try:
            async with _chat_client(timeout) as client:
                async with client.stream("POST", target_url, headers=headers, json=payload) as resp:
                    if resp.status_code >= 400:
                        detail = await resp.aread()
                        yield "data: " + json.dumps(
                            _format_upstream_error(resp.status_code, detail),
                            ensure_ascii=False,
                        ) + "\n\n"
                        return

                    async for chunk in resp.aiter_text():
                        if chunk:
                            yield chunk
        except httpx.HTTPError as exc:
            yield (
                'data: {"error":{"message":"Hermes-agent unavailable: '
                + str(exc).replace('"', '\\"')
                + '"}}\n\n'
            )

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
