"""当前用户上下文：与 X-User-ID / 飞书会话一致。"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import get_db
from backend.services.feishu_auth import get_user_session
from backend.services.user_identity import (
    derive_user_id,
    effective_user_id_for_api,
    feishu_effective_user_id,
    get_effective_user_id,
    normalize_user_id,
    viewer_role,
)
from backend.services.user_preference_service import (
    PREF_KEY_UNIFIED_USER_ID,
    get_user_preferences,
    set_unified_user_id,
)

router = APIRouter(tags=["user"])


class IdentitySyncIn(BaseModel):
    unified_user_id: str = Field(min_length=1, max_length=128)


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


@router.get("/me/identity")
async def api_me_identity(
    req: Request,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    """跨设备统一 User ID：飞书用户以 feishu:* 为主；也可保存自定义 unified_user_id。"""
    feishu_id = feishu_effective_user_id(req)
    prefs = await get_user_preferences(db, effective_uid)
    unified = str(prefs.get(PREF_KEY_UNIFIED_USER_ID) or "").strip()
    if feishu_id and not unified:
        unified = feishu_id
    return {
        "effective_user_id": effective_uid,
        "unified_user_id": unified or effective_uid,
        "feishu_bound": bool(feishu_id),
        "source": "feishu" if feishu_id else ("custom" if unified else "anonymous"),
    }


@router.put("/me/identity")
async def api_put_me_identity(
    body: IdentitySyncIn,
    req: Request,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    unified = normalize_user_id(body.unified_user_id.strip())
    await set_unified_user_id(db, effective_uid, unified)
    if unified != effective_uid:
        await set_unified_user_id(db, unified, unified)
    return {
        "ok": True,
        "unified_user_id": unified,
        "effective_user_id": effective_uid,
        "feishu_bound": bool(feishu_effective_user_id(req)),
    }


@router.post("/me/identity/generate")
async def api_generate_unified_user_id():
    """生成可跨 PC 共用的随机 User ID。"""
    return {"unified_user_id": f"user_{uuid.uuid4().hex[:12]}"}
