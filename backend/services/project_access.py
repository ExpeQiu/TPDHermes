"""项目归属校验：owner / 成员 Role + 全局管理员。"""
from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.project import Project
from backend.services.project_member_service import (
    get_project_role,
    list_member_project_ids,
    project_visibility_filter,
)
from backend.services.rbac import project_perm_allowed
from backend.services.user_identity import is_global_admin_user


async def get_project_if_visible(
    db: AsyncSession,
    project_id: str,
    user_id: str,
) -> Project | None:
    row = await db.get(Project, project_id)
    if not row:
        return None
    role = await get_project_role(db, project_id=project_id, user_id=user_id, project=row)
    if role and project_perm_allowed(role, "read"):
        return row
    return None


async def require_project_for_user(
    db: AsyncSession,
    project_id: str,
    user_id: str,
    *,
    detail: str = "Project not found",
    min_perm: str = "read",
) -> Project:
    row = await db.get(Project, project_id)
    if not row:
        raise HTTPException(status_code=404, detail=detail)
    role = await get_project_role(db, project_id=project_id, user_id=user_id, project=row)
    if not role or not project_perm_allowed(role, min_perm):
        raise HTTPException(status_code=404, detail=detail)
    return row


async def list_visible_project_filter(db: AsyncSession, user_id: str):
    if is_global_admin_user(user_id):
        return None
    member_ids = await list_member_project_ids(db, user_id)
    return project_visibility_filter(user_id, member_ids)


def project_owner_id(project: Project) -> str:
    return (project.owner_id or "default").strip()
