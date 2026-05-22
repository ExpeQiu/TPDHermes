"""当前用户上下文：与 X-User-ID / 飞书会话一致。"""

from __future__ import annotations

from fastapi import APIRouter, Request

from backend.services.feishu_auth import get_user_session
from backend.services.user_identity import (
    derive_user_id,
    effective_user_id_for_api,
    feishu_effective_user_id,
    viewer_role,
)

router = APIRouter(tags=["user"])


@router.get("/me/derived-user-id")
async def api_derived_user_id(req: Request):
    """按 IP + User-Agent 生成匿名 ID（与未传 X-User-ID 时服务端推导一致）。"""
    return {"user_id": derive_user_id(req, None)}


@router.get("/me")
async def api_me(req: Request):
    uid = effective_user_id_for_api(req)
    role = viewer_role(req)
    feishu_id = feishu_effective_user_id(req)
    name: str | None = None
    avatar_url: str | None = None
    tok = (
        (req.headers.get("X-Feishu-Session-Token") or req.headers.get("x-feishu-session-token") or "").strip()
    )
    if tok:
        u = get_user_session(tok)
        if u:
            name = u.name or None
            avatar_url = u.avatar_url
    return {
        "user_id": uid,
        "role": role,
        "feishu_bound": bool(feishu_id),
        "name": name,
        "avatar_url": avatar_url,
    }
