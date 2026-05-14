"""
聊天代理路由：统一由 TPDHermes 后端承接，再转发到 Hermes-agent。
"""

from __future__ import annotations

import os
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
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(target_url, headers=headers, json=payload)
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"Hermes-agent unavailable: {exc}") from exc

        return JSONResponse(
            status_code=resp.status_code,
            content=resp.json() if resp.content else {},
            headers={k: v for k, v in resp.headers.items() if k.lower() in {"content-type"}},
        )

    async def event_stream():
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with client.stream("POST", target_url, headers=headers, json=payload) as resp:
                    if resp.status_code >= 400:
                        detail = await resp.aread()
                        yield (
                            "data: "
                            + (
                                detail.decode("utf-8", errors="ignore")
                                or '{"error":{"message":"Hermes-agent error"}}'
                            )
                            + "\n\n"
                        )
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
