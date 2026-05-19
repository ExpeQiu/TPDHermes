"""
Project Tools for TPDHermes MCP Server

Wraps Project CRUD operations for MCP access.
"""

import json
import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import select

from backend.db import async_session_maker
from backend.models.project import Project
from backend.services.user_identity import is_global_admin_user


async def project_list(status: Optional[str] = None, user_id: str = "") -> dict:
    """
    List projects visible to user_id (owner match; global admin sees all).

    Args:
        status: Optional filter by project status (e.g. "active")
        user_id: Effective user id from MCP caller (header / context)

    Returns:
        {
            "projects": [ProjectResponse, ...],
            "count": int
        }
    """
    uid = (user_id or "").strip() or "default"
    async with async_session_maker() as db:
        query = select(Project)
        if status:
            query = query.where(Project.status == status)
        if not is_global_admin_user(uid):
            query = query.where(Project.owner_id == uid)
        query = query.order_by(Project.created_at.desc())
        result = await db.execute(query)
        projects = result.scalars().all()

    return {
        "projects": [_project_to_dict(p) for p in projects],
        "count": len(projects),
    }


async def project_create(
    name: str,
    description: Optional[str] = None,
    background: Optional[str] = None,
    user_id: str = "default",
) -> dict:
    """
    Create a new project.

    Args:
        name: Project name (required)
        description: Optional project description
        background: Optional background/context for the project

    Returns:
        The created project as a dict
    """
    async with async_session_maker() as db:
        owner = (user_id or "").strip() or "default"
        project = Project(
            id=str(uuid.uuid4()),
            name=name,
            description=description,
            background=background,
            status="active",
            owner_id=owner,
            created_at=datetime.now().isoformat(),
            updated_at=datetime.now().isoformat(),
        )
        db.add(project)
        await db.commit()
        await db.refresh(project)
        result = _project_to_dict(project)

    return result


async def project_get(id: str, user_id: str = "") -> dict:
    """
    Get a project by ID.

    Args:
        id: The project ID

    Returns:
        The project as a dict, or an empty dict if not found
    """
    async with async_session_maker() as db:
        result = await db.execute(select(Project).where(Project.id == id))
        project = result.scalar_one_or_none()

    if not project:
        return {}
    uid = (user_id or "").strip() or "default"
    owner = (getattr(project, "owner_id", None) or "default").strip()
    if not is_global_admin_user(uid) and owner != uid:
        return {}
    return _project_to_dict(project)


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _project_to_dict(project: Project) -> dict:
    constraints_val = None
    if project.constraints:
        try:
            constraints_val = json.loads(str(project.constraints))
        except json.JSONDecodeError:
            constraints_val = str(project.constraints)

    return {
        "id": project.id,
        "name": project.name,
        "description": project.description,
        "background": project.background,
        "audience": project.audience,
        "deadline": project.deadline,
        "constraints": constraints_val,
        "status": project.status,
        "owner_id": getattr(project, "owner_id", None) or "default",
        "created_at": project.created_at,
        "updated_at": project.updated_at,
    }
