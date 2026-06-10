"""平台 Role 与功能/项目权限定义。"""
from __future__ import annotations

import logging
import os
from typing import Literal

from fastapi import Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import get_db
from backend.services.user_identity import get_effective_user_id, is_global_admin_user, viewer_role
from backend.services.user_preference_service import PREF_KEY_PLATFORM_ROLE, get_user_preferences

logger = logging.getLogger("tpdx.hermes.rbac")

PlatformRole = Literal["platform_admin", "tenant_admin", "tenant_editor", "tenant_partner"]
ProjectRole = Literal["owner", "editor", "viewer"]

PLATFORM_ROLES: frozenset[str] = frozenset(
    {"platform_admin", "tenant_admin", "tenant_editor", "tenant_partner"}
)
ROLE_ALIASES: dict[str, str] = {"tenant_viewer": "tenant_partner"}
PROJECT_ROLES: frozenset[str] = frozenset({"owner", "editor", "viewer"})
PROJECT_ROLE_RANK: dict[str, int] = {"viewer": 1, "editor": 2, "owner": 3}

FEATURE_KEYS: frozenset[str] = frozenset(
    {"create", "knowledge", "skills", "projects", "chat", "workshop", "ops", "settings"}
)

FEATURES_BY_PLATFORM_ROLE: dict[str, frozenset[str]] = {
    "platform_admin": frozenset(FEATURE_KEYS),
    "tenant_admin": frozenset(
        {"create", "knowledge", "skills", "projects", "chat", "workshop", "ops", "settings"}
    ),
    "tenant_editor": frozenset(
        {"create", "knowledge", "skills", "projects", "chat", "workshop", "settings"}
    ),
    "tenant_partner": frozenset({"projects", "chat", "workshop", "settings"}),
}

PROJECT_PERMS_BY_ROLE: dict[str, frozenset[str]] = {
    "viewer": frozenset({"read"}),
    "editor": frozenset({"read", "write"}),
    "owner": frozenset({"read", "write", "delete", "manage_members"}),
}

PLATFORM_ROLE_LABELS: dict[str, str] = {
    "platform_admin": "平台管理员",
    "tenant_admin": "系统管理员",
    "tenant_editor": "项目管理员",
    "tenant_partner": "项目成员",
}

PROJECT_ROLE_LABELS: dict[str, str] = {
    "owner": "负责人",
    "editor": "编辑",
    "viewer": "只读",
}


def normalize_platform_role(value: str | None) -> str | None:
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    if s in PLATFORM_ROLES:
        return s
    aliased = ROLE_ALIASES.get(s)
    if aliased and aliased in PLATFORM_ROLES:
        return aliased
    return None


def normalize_project_role(value: str | None) -> str | None:
    if value is None:
        return None
    s = str(value).strip()
    if s in PROJECT_ROLES:
        return s
    return None


def is_default_platform_admin_user(user_id: str) -> bool:
    return (user_id or "").strip() == "default"


async def resolve_platform_role(
    db: AsyncSession,
    request: Request | None,
    user_id: str,
) -> str:
    """解析平台 Role：全局管理员 > 服务端偏好 >（可选）客户端头 > 环境默认。"""
    uid = (user_id or "").strip() or "default"
    if is_global_admin_user(uid) or is_default_platform_admin_user(uid):
        return "platform_admin"

    prefs = await get_user_preferences(db, uid)
    from_pref = normalize_platform_role(str(prefs.get(PREF_KEY_PLATFORM_ROLE) or ""))
    if from_pref:
        return from_pref

    trust_header = os.getenv("TPDHERMES_TRUST_CLIENT_ROLE_HEADER", "0").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )
    if trust_header and request is not None:
        header_role = normalize_platform_role(viewer_role(request))
        if header_role:
            logger.debug("platform_role from trusted header user=%s role=%s", uid[:24], header_role)
            return header_role

    env_default = normalize_platform_role(os.getenv("TPDHERMES_DEFAULT_USER_ROLE", "tenant_admin"))
    return env_default or "tenant_admin"


def feature_allowed(platform_role: str, feature: str) -> bool:
    feats = FEATURES_BY_PLATFORM_ROLE.get(platform_role, FEATURES_BY_PLATFORM_ROLE["tenant_partner"])
    return feature in feats


def list_features(platform_role: str) -> list[str]:
    feats = FEATURES_BY_PLATFORM_ROLE.get(platform_role, FEATURES_BY_PLATFORM_ROLE["tenant_partner"])
    return sorted(feats)


def project_perm_allowed(project_role: str, perm: str) -> bool:
    perms = PROJECT_PERMS_BY_ROLE.get(project_role, frozenset())
    return perm in perms


def project_role_at_least(project_role: str, minimum: str) -> bool:
    return PROJECT_ROLE_RANK.get(project_role, 0) >= PROJECT_ROLE_RANK.get(minimum, 99)


async def get_platform_role(
    req: Request,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_effective_user_id),
) -> str:
    return await resolve_platform_role(db, req, user_id)


def require_feature(feature: str):
    async def _dep(role: str = Depends(get_platform_role)) -> str:
        if not feature_allowed(role, feature):
            logger.warning("feature denied role=%s feature=%s", role, feature)
            raise HTTPException(status_code=403, detail=f"当前角色无权访问功能: {feature}")
        return role

    return _dep


SYSTEM_ADMIN_ROLES: frozenset[str] = frozenset({"tenant_admin", "platform_admin"})


def assert_assignable_platform_role(user_id: str, role: str) -> str:
    """用户自助设置 Role 时禁止自行提升为 platform_admin。"""
    return _assert_assignable_platform_role(user_id, role, self_service=True)


def assert_admin_assignable_platform_role(actor_user_id: str, role: str) -> str:
    """系统管理员为他人分配 Role。"""
    return _assert_assignable_platform_role(actor_user_id, role, self_service=False)


def _assert_assignable_platform_role(user_id: str, role: str, *, self_service: bool) -> str:
    normalized = normalize_platform_role(role)
    if not normalized:
        raise HTTPException(status_code=400, detail=f"无效的平台 Role: {role}")
    if normalized == "platform_admin" and not (
        is_global_admin_user(user_id) or is_default_platform_admin_user(user_id)
    ):
        detail = "platform_admin 仅可由全局管理员分配"
        if self_service:
            detail = "platform_admin 仅可由全局管理员分配"
        raise HTTPException(status_code=403, detail=detail)
    return normalized


def require_system_admin():
    """仅系统管理员（tenant_admin / platform_admin）可访问。"""

    async def _dep(role: str = Depends(get_platform_role)) -> str:
        if role not in SYSTEM_ADMIN_ROLES:
            logger.warning("system_admin denied role=%s", role)
            raise HTTPException(status_code=403, detail="仅系统管理员可操作")
        return role

    return _dep
