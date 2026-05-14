from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
import json
import uuid
from datetime import datetime
from typing import Optional

from backend.db import get_db
from backend.models.project import Project
from backend.models.output_asset import OutputAsset
from backend.models.orchestration_run import OrchestrationRun
from pydantic import BaseModel

from backend.schemas.orchestration import TaskExecuteRequest, TaskExecuteOverrides
from backend.services.orchestration_service import assemble_payload

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


# --- 编排：预览与输出物 / 运行记录 ---


class OrchestrationPreviewBody(BaseModel):
    scenario_id: str | None = "general"
    user_message: str = "（编排预览）"
    scenario_preset_instructions: str | None = None
    scenario_opening_hint: str | None = None
    overrides: TaskExecuteOverrides | None = None


@router.post("/{project_id}/orchestration/preview")
async def orchestration_preview(
    project_id: str,
    body: OrchestrationPreviewBody,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Project).where(Project.id == project_id))
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Project not found")
    req = TaskExecuteRequest(
        entrypoint="chat",
        project_id=project_id,
        scenario_id=body.scenario_id,
        user_message=body.user_message,
        stream=False,
        scenario_preset_instructions=body.scenario_preset_instructions,
        scenario_opening_hint=body.scenario_opening_hint,
        overrides=body.overrides,
    )
    payload, snapshot = await assemble_payload(db, req)
    return {"payload": payload.model_dump(mode="json"), "snapshot": snapshot}


class OutputListItem(BaseModel):
    id: str
    title: str | None
    summary: str | None
    template_id: str | None
    run_id: str | None
    status: str
    created_at: str | None
    content_preview: str


class OutputDetailResponse(BaseModel):
    id: str
    project_id: str
    title: str | None
    summary: str | None
    template_id: str | None
    run_id: str | None
    status: str
    created_at: str | None
    updated_at: str | None
    content_format: str
    content: str


@router.get("/{project_id}/outputs", response_model=list[OutputListItem])
async def list_project_outputs(project_id: str, db: AsyncSession = Depends(get_db)):
    res = await db.execute(select(Project).where(Project.id == project_id))
    if not res.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Project not found")
    q = await db.execute(
        select(OutputAsset)
        .where(OutputAsset.project_id == project_id)
        .order_by(OutputAsset.created_at.desc())
    )
    rows = q.scalars().all()
    out: list[OutputListItem] = []
    for o in rows:
        preview = (o.content or "")[:200]
        out.append(
            OutputListItem(
                id=o.id,
                title=o.title,
                summary=o.summary,
                template_id=o.template_id,
                run_id=o.run_id,
                status=o.status,
                created_at=o.created_at,
                content_preview=preview,
            )
        )
    return out


@router.get("/{project_id}/outputs/{output_id}", response_model=OutputDetailResponse)
async def get_project_output_detail(
    project_id: str,
    output_id: str,
    db: AsyncSession = Depends(get_db),
):
    res = await db.execute(select(Project).where(Project.id == project_id))
    if not res.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Project not found")
    q = await db.execute(
        select(OutputAsset).where(
            OutputAsset.id == output_id,
            OutputAsset.project_id == project_id,
        )
    )
    row = q.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Output not found")
    return OutputDetailResponse(
        id=row.id,
        project_id=row.project_id,
        title=row.title,
        summary=row.summary,
        template_id=row.template_id,
        run_id=row.run_id,
        status=row.status,
        created_at=row.created_at,
        updated_at=row.updated_at,
        content_format=row.content_format or "markdown",
        content=row.content or "",
    )


class RunListItem(BaseModel):
    id: str
    entrypoint: str
    status: str
    created_at: str | None
    duration_ms: int | None


@router.get("/{project_id}/runs", response_model=list[RunListItem])
async def list_project_runs(project_id: str, db: AsyncSession = Depends(get_db)):
    res = await db.execute(select(Project).where(Project.id == project_id))
    if not res.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Project not found")
    q = await db.execute(
        select(OrchestrationRun)
        .where(OrchestrationRun.project_id == project_id)
        .order_by(OrchestrationRun.created_at.desc())
        .limit(100)
    )
    rows = q.scalars().all()
    return [
        RunListItem(
            id=r.id,
            entrypoint=r.entrypoint,
            status=r.status,
            created_at=r.created_at,
            duration_ms=r.duration_ms,
        )
        for r in rows
    ]
