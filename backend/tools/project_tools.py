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


async def project_list(status: Optional[str] = None) -> dict:
    """
    List all projects.

    Args:
        status: Optional filter by project status (e.g. "active")

    Returns:
        {
            "projects": [ProjectResponse, ...],
            "count": int
        }
    """
    async with async_session_maker() as db:
        query = select(Project)
        if status:
            query = query.where(Project.status == status)
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
        project = Project(
            id=str(uuid.uuid4()),
            name=name,
            description=description,
            background=background,
            status="active",
            created_at=datetime.now().isoformat(),
            updated_at=datetime.now().isoformat(),
        )
        db.add(project)
        await db.commit()
        await db.refresh(project)
        result = _project_to_dict(project)

    return result


async def project_get(id: str) -> dict:
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
    return _project_to_dict(project)


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _project_to_dict(project: Project) -> dict:
    constraints_val = None
    if project.constraints:
        try:
            constraints_val = json.loads(project.constraints)
        except json.JSONDecodeError:
            constraints_val = project.constraints

    return {
        "id": project.id,
        "name": project.name,
        "description": project.description,
        "background": project.background,
        "audience": project.audience,
        "deadline": project.deadline,
        "constraints": constraints_val,
        "status": project.status,
        "created_at": project.created_at,
        "updated_at": project.updated_at,
    }
