"""
聊天代理路由：统一由 TPDHermes 后端承接，再转发到 Hermes-agent。
"""

from __future__ import annotations

import os
import json
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict

from backend.env_policy import allow_missing_chat_upstream

router = APIRouter(prefix="/chat", tags=["chat"])


class ChatMessage(BaseModel):
    role: str
    content: Any


class ChatCompletionRequest(BaseModel):
    model_config = ConfigDict(extra="allow")

    model: str = "hermes-agent"
    messages: list[ChatMessage]
    stream: bool = True


def _resolve_chat_target() -> tuple[str, str] | None:
    """
    返回 (url, api_key)；若未配置 URL：
    - 与启动策略一致允许缺省时返回 None（供 /config 与合规 503）
    - 否则抛错（生产等应配置）
    """
    url = os.getenv("HERMES_CHAT_API_URL", "").strip()
    api_key = os.getenv("HERMES_CHAT_API_KEY", "").strip()
    if url:
        return url, api_key
    if allow_missing_chat_upstream():
        return None
    raise RuntimeError(
        "HERMES_CHAT_API_URL environment variable is not set. "
        "Cannot proxy chat requests without a configured upstream URL."
    )


def _chat_target_required() -> tuple[str, str]:
    """代理请求必须存在上游。"""
    t = _resolve_chat_target()
    if t is None:
        raise HTTPException(
            status_code=503,
            detail="聊天上游未配置。请设置环境变量 HERMES_CHAT_API_URL。",
        )
    return t


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
    target = _resolve_chat_target()
    model = os.getenv("HERMES_CHAT_MODEL", "hermes-agent")
    if target is None:
        return {
            "mode": "backend-proxy",
            "target": None,
            "available": False,
            "reason": "HERMES_CHAT_API_URL not configured",
            "model": model,
        }
    url, _api_key = target
    return {
        "mode": "backend-proxy",
        "target": url,
        "available": True,
        "model": model,
    }


@router.post("/completions")
async def chat_completions(req: Request, request: ChatCompletionRequest):
    """代理 OpenAI 兼容聊天补全请求到 Hermes-agent。"""
    target_url, api_key = _chat_target_required()
    payload = request.model_dump(exclude_none=True)
    payload.setdefault("model", os.getenv("HERMES_CHAT_MODEL", "hermes-agent"))

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    uid = (req.headers.get("X-User-ID") or req.headers.get("x-user-id") or "").strip()
    if uid:
        headers["X-User-ID"] = uid
    role = (req.headers.get("X-User-Role") or req.headers.get("x-user-role") or "").strip()
    if role:
        headers["X-User-Role"] = role
    tok = (req.headers.get("X-Feishu-Session-Token") or req.headers.get("x-feishu-session-token") or "").strip()
    if tok:
        headers["X-Feishu-Session-Token"] = tok

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
