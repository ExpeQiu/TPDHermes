"""当前用户上下文：与 X-User-ID / 飞书会话 / 平台 Role 一致。"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import get_db
from backend.services.feishu_auth import get_user_session
from backend.services.rbac import (
    PLATFORM_ROLE_LABELS,
    PROJECT_ROLE_LABELS,
    assert_admin_assignable_platform_role,
    assert_assignable_platform_role,
    ensure_default_member_platform_role,
    list_features,
    require_system_admin,
    resolve_platform_role,
)
from backend.services.user_directory_service import is_claimed_user_id, list_identity_claimed_users
from backend.services.user_identity import (
    derive_user_id,
    effective_user_id_for_api,
    feishu_effective_user_id,
    get_effective_user_id,
    is_global_admin_user,
    normalize_user_id,
    viewer_role,
)
from backend.services.user_preference_service import (
    PREF_KEY_UNIFIED_USER_ID,
    get_user_preferences,
    set_platform_role,
    set_unified_user_id,
)

router = APIRouter(tags=["user"])


class IdentitySyncIn(BaseModel):
    unified_user_id: str = Field(min_length=1, max_length=128)


class PlatformRoleIn(BaseModel):
    platform_role: str = Field(min_length=1, max_length=64)


class ManagedUserResponse(BaseModel):
    user_id: str
    unified_user_id: str
    display_name: str
    avatar_initial: str
    platform_role: str | None = None
    platform_role_label: str | None = None
    resolved_platform_role: str
    resolved_platform_role_label: str


class AssignManagedUserRoleIn(BaseModel):
    platform_role: str = Field(min_length=1, max_length=64)


@router.get("/me/derived-user-id")
async def api_derived_user_id(req: Request):
    """按 IP + User-Agent 生成匿名 ID（与未传 X-User-ID 时服务端推导一致）。"""
    return {"user_id": derive_user_id(req, None)}


@router.get("/me")
async def api_me(
    req: Request,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    uid = effective_user_id_for_api(req)
    platform_role = await resolve_platform_role(db, req, effective_uid)
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
        "role": platform_role,
        "header_role": viewer_role(req),
        "platform_role": platform_role,
        "is_global_admin": is_global_admin_user(effective_uid),
        "feishu_bound": bool(feishu_id),
        "name": name,
        "avatar_url": avatar_url,
    }


@router.get("/me/access")
async def api_me_access(
    req: Request,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    """平台 Role、功能入口权限与 Role 字典（供前端导航/守卫）。"""
    platform_role = await resolve_platform_role(db, req, effective_uid)
    return {
        "user_id": effective_uid,
        "platform_role": platform_role,
        "platform_role_label": PLATFORM_ROLE_LABELS.get(platform_role, platform_role),
        "features": list_features(platform_role),
        "is_global_admin": is_global_admin_user(effective_uid),
        "platform_roles": [
            {"id": rid, "label": PLATFORM_ROLE_LABELS[rid]} for rid in sorted(PLATFORM_ROLE_LABELS)
        ],
        "project_roles": [
            {"id": rid, "label": PROJECT_ROLE_LABELS[rid]} for rid in sorted(PROJECT_ROLE_LABELS)
        ],
    }


@router.put("/me/role")
async def api_put_me_role(
    body: PlatformRoleIn,
    req: Request,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    """保存平台 Role 到用户偏好（禁止自助提升为 platform_admin）。"""
    role = assert_assignable_platform_role(effective_uid, body.platform_role)
    await set_platform_role(db, effective_uid, role)
    return {
        "ok": True,
        "platform_role": role,
        "features": list_features(role),
        "is_global_admin": is_global_admin_user(effective_uid),
        "feishu_bound": bool(feishu_effective_user_id(req)),
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
    for uid in {effective_uid, unified}:
        await ensure_default_member_platform_role(db, uid)
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


@router.get("/me/managed-users", response_model=list[ManagedUserResponse])
async def api_list_managed_users(
    db: AsyncSession = Depends(get_db),
    _admin_role: str = Depends(require_system_admin()),
):
    """系统管理员：列出已同步 User ID 的用户。"""
    rows = await list_identity_claimed_users(db)
    out: list[ManagedUserResponse] = []
    for row in rows:
        uid = str(row["user_id"] or "").strip()
        resolved = await resolve_platform_role(db, None, uid)
        out.append(
            ManagedUserResponse(
                user_id=uid,
                unified_user_id=str(row.get("unified_user_id") or uid),
                display_name=str(row.get("display_name") or uid),
                avatar_initial=str(row.get("avatar_initial") or "U"),
                platform_role=row.get("platform_role"),
                platform_role_label=row.get("platform_role_label"),
                resolved_platform_role=resolved,
                resolved_platform_role_label=PLATFORM_ROLE_LABELS.get(resolved, resolved),
            )
        )
    return out


@router.put("/me/managed-users/{target_user_id}/role")
async def api_assign_managed_user_role(
    target_user_id: str,
    body: AssignManagedUserRoleIn,
    db: AsyncSession = Depends(get_db),
    actor_uid: str = Depends(get_effective_user_id),
    _admin_role: str = Depends(require_system_admin()),
):
    """系统管理员：为已同步 User ID 的用户分配平台分组。"""
    target = normalize_user_id(target_user_id.strip())
    if not is_claimed_user_id(target):
        raise HTTPException(status_code=400, detail="仅可为已同步 User ID 的用户分配分组")
    role = assert_admin_assignable_platform_role(actor_uid, body.platform_role)
    await set_platform_role(db, target, role)
    resolved = await resolve_platform_role(db, None, target)
    return {
        "ok": True,
        "user_id": target,
        "platform_role": role,
        "resolved_platform_role": resolved,
        "platform_role_label": PLATFORM_ROLE_LABELS.get(role, role),
        "features": list_features(resolved),
    }
