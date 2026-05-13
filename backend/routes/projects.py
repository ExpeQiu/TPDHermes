from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
import json
import uuid
from datetime import datetime
from typing import Optional

from backend.db import get_db
from backend.models.project import Project
from pydantic import BaseModel

router = APIRouter(prefix="/projects", tags=["projects"])


# --- Pydantic Schemas ---

class ProjectCreate(BaseModel):
    name: str
    description: Optional[str] = None
    background: Optional[str] = None
    audience: Optional[str] = None
    deadline: Optional[str] = None
    constraints: Optional[dict] = None


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    background: Optional[str] = None
    audience: Optional[str] = None
    deadline: Optional[str] = None
    constraints: Optional[dict] = None
    status: Optional[str] = None


class ProjectResponse(BaseModel):
    id: str
    name: str
    description: Optional[str]
    background: Optional[str]
    audience: Optional[str]
    deadline: Optional[str]
    constraints: Optional[dict]
    status: str
    created_at: str
    updated_at: str


def _project_to_response(project: Project) -> ProjectResponse:
    constraints_val = None
    if project.constraints:
        try:
            constraints_val = json.loads(project.constraints)
        except json.JSONDecodeError:
            constraints_val = project.constraints

    return ProjectResponse(
        id=project.id,
        name=project.name,
        description=project.description,
        background=project.background,
        audience=project.audience,
        deadline=project.deadline,
        constraints=constraints_val,
        status=project.status,
        created_at=project.created_at,
        updated_at=project.updated_at,
    )


# --- Endpoints ---

@router.post("/", response_model=ProjectResponse)
async def create_project(data: ProjectCreate, db: AsyncSession = Depends(get_db)):
    constraints_str = json.dumps(data.constraints) if data.constraints else None
    project = Project(
        id=str(uuid.uuid4()),
        name=data.name,
        description=data.description,
        background=data.background,
        audience=data.audience,
        deadline=data.deadline,
        constraints=constraints_str,
        status="active",
        created_at=datetime.now().isoformat(),
        updated_at=datetime.now().isoformat(),
    )
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return _project_to_response(project)


@router.get("/", response_model=list[ProjectResponse])
async def list_projects(
    status: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    query = select(Project)
    if status:
        query = query.where(Project.status == status)
    query = query.order_by(Project.created_at.desc())
    result = await db.execute(query)
    projects = result.scalars().all()
    return [_project_to_response(p) for p in projects]


@router.get("/{project_id}", response_model=ProjectResponse)
async def get_project(project_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return _project_to_response(project)


@router.put("/{project_id}", response_model=ProjectResponse)
async def update_project(
    project_id: str,
    data: ProjectUpdate,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    update_data = data.model_dump(exclude_unset=True)
    if "constraints" in update_data:
        update_data["constraints"] = (
            json.dumps(update_data["constraints"]) if update_data["constraints"] else None
        )
    update_data["updated_at"] = datetime.now().isoformat()

    for key, value in update_data.items():
        setattr(project, key, value)

    await db.commit()
    await db.refresh(project)
    return _project_to_response(project)


@router.delete("/{project_id}")
async def delete_project(project_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Project).where(Project.id == project_id))
    project = result.scalar_one_or_none()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    await db.delete(project)
    await db.commit()
    return {"message": "Project deleted"}
