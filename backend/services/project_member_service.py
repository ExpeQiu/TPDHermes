"""项目成员 CRUD 与 Role 解析。"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.project import Project
from backend.models.project_member import ProjectMember
from backend.services.rbac import normalize_project_role, project_perm_allowed
from backend.services.user_identity import is_global_admin_user

logger = logging.getLogger("tpdx.hermes.project_members")


async def ensure_owner_membership(
    db: AsyncSession,
    *,
    project_id: str,
    owner_user_id: str,
) -> None:
    """新建项目时写入 owner 成员记录。"""
    uid = (owner_user_id or "default").strip() or "default"
    existing = await db.execute(
        select(ProjectMember).where(
            ProjectMember.project_id == project_id,
            ProjectMember.user_id == uid,
        )
    )
    if existing.scalar_one_or_none():
        return
    now = datetime.now().isoformat()
    db.add(
        ProjectMember(
            id=str(uuid.uuid4()),
            project_id=project_id,
            user_id=uid,
            role="owner",
            created_at=now,
            updated_at=now,
        )
    )
    logger.info("project member seeded owner project=%s user=%s", project_id[:8], uid[:24])


async def get_project_role(
    db: AsyncSession,
    *,
    project_id: str,
    user_id: str,
    project: Project | None = None,
) -> str | None:
    uid = (user_id or "default").strip() or "default"
    if is_global_admin_user(uid):
        return "owner"
    row = project or await db.get(Project, project_id)
    if not row:
        return None
    owner = (row.owner_id or "default").strip() or "default"
    if owner == uid:
        return "owner"
    member = (
        await db.execute(
            select(ProjectMember.role).where(
                ProjectMember.project_id == project_id,
                ProjectMember.user_id == uid,
            )
        )
    ).scalar_one_or_none()
    if isinstance(member, str) and member.strip():
        return normalize_project_role(member) or member.strip()
    return None


async def list_member_project_ids(db: AsyncSession, user_id: str) -> set[str]:
    uid = (user_id or "default").strip() or "default"
    rows = await db.execute(select(ProjectMember.project_id).where(ProjectMember.user_id == uid))
    return {str(r[0]).strip() for r in rows.all() if str(r[0]).strip()}


async def list_project_members(db: AsyncSession, project_id: str) -> list[ProjectMember]:
    rows = await db.execute(
        select(ProjectMember)
        .where(ProjectMember.project_id == project_id)
        .order_by(ProjectMember.created_at.asc())
    )
    return list(rows.scalars().all())


async def upsert_project_member(
    db: AsyncSession,
    *,
    project_id: str,
    member_user_id: str,
    role: str,
) -> ProjectMember:
    normalized_role = normalize_project_role(role)
    if not normalized_role:
        raise HTTPException(status_code=400, detail=f"无效的项目 Role: {role}")
    uid = (member_user_id or "").strip()
    if not uid:
        raise HTTPException(status_code=400, detail="member user_id 不能为空")

    existing = (
        await db.execute(
            select(ProjectMember).where(
                ProjectMember.project_id == project_id,
                ProjectMember.user_id == uid,
            )
        )
    ).scalar_one_or_none()
    now = datetime.now().isoformat()
    if existing:
        existing.role = normalized_role
        existing.updated_at = now
        await db.commit()
        await db.refresh(existing)
        logger.info(
            "project member updated project=%s user=%s role=%s",
            project_id[:8],
            uid[:24],
            normalized_role,
        )
        return existing

    row = ProjectMember(
        id=str(uuid.uuid4()),
        project_id=project_id,
        user_id=uid,
        role=normalized_role,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    logger.info(
        "project member added project=%s user=%s role=%s",
        project_id[:8],
        uid[:24],
        normalized_role,
    )
    return row


async def remove_project_member(
    db: AsyncSession,
    *,
    project_id: str,
    member_user_id: str,
    owner_user_id: str,
) -> None:
    uid = (member_user_id or "").strip()
    if not uid:
        raise HTTPException(status_code=400, detail="member user_id 不能为空")
    if uid == (owner_user_id or "default").strip():
        raise HTTPException(status_code=400, detail="不能移除项目负责人")
    await db.execute(
        delete(ProjectMember).where(
            ProjectMember.project_id == project_id,
            ProjectMember.user_id == uid,
        )
    )
    await db.commit()
    logger.info("project member removed project=%s user=%s", project_id[:8], uid[:24])


async def require_project_permission(
    db: AsyncSession,
    project_id: str,
    user_id: str,
    perm: str,
    *,
    detail: str = "Project not found",
) -> tuple[Project, str]:
    project = await db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail=detail)
    role = await get_project_role(db, project_id=project_id, user_id=user_id, project=project)
    if not role or not project_perm_allowed(role, perm):
        raise HTTPException(status_code=404, detail=detail)
    return project, role


def project_visibility_filter(user_id: str, member_project_ids: set[str]):
    uid = (user_id or "default").strip() or "default"
    if not member_project_ids:
        return Project.owner_id == uid
    return or_(Project.owner_id == uid, Project.id.in_(member_project_ids))
