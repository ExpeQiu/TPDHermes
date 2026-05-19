"""项目归属校验：按 owner_id 隔离，全局管理员可绕过。"""
from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.project import Project
from backend.services.user_identity import is_global_admin_user


async def get_project_if_visible(
    db: AsyncSession,
    project_id: str,
    user_id: str,
) -> Project | None:
    row = await db.get(Project, project_id)
    if not row:
        return None
    if is_global_admin_user(user_id):
        return row
    owner = (row.owner_id or "default").strip()
    if owner != (user_id or "default").strip():
        return None
    return row


async def require_project_for_user(
    db: AsyncSession,
    project_id: str,
    user_id: str,
    *,
    detail: str = "Project not found",
) -> Project:
    row = await get_project_if_visible(db, project_id, user_id)
    if not row:
        raise HTTPException(status_code=404, detail=detail)
    return row


def project_owner_id(project: Project) -> str:
    return (project.owner_id or "default").strip()
