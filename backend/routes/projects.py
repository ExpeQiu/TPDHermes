from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, Request
from fastapi.responses import FileResponse
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
import json
import logging
import os
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from backend.db import get_db
from backend.models.project import Project
from backend.models.output_asset import OutputAsset
from backend.models.orchestration_run import OrchestrationRun
from backend.models.project_scenario import ProjectScenario
from backend.models.scenario_profile import ScenarioProfile
from backend.models.project_attachment import ProjectAttachment
from pydantic import BaseModel

from backend.schemas.orchestration import TaskExecuteRequest, TaskExecuteOverrides
from backend.services.orchestration_service import assemble_payload
from backend.services.project_access import require_project_for_user
from backend.services.user_identity import get_effective_user_id, is_global_admin_user, viewer_role
from backend.data.builtin_scenarios import BUILTIN_SCENARIOS, BUILTIN_VERSION

router = APIRouter(prefix="/projects", tags=["projects"])

logger = logging.getLogger("tpdx.hermes")
_MAX_ATTACHMENT_BYTES = int(os.getenv("PROJECT_ATTACHMENT_MAX_BYTES", str(32 * 1024 * 1024)))


def _attachments_root() -> Path:
    override = os.getenv("PROJECT_UPLOAD_DIR", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return (Path(__file__).resolve().parent.parent / "data" / "project_uploads").resolve()


def _safe_original_filename(name: str | None) -> str:
    base = (name or "unnamed").replace("\\", "_").replace("/", "_").strip() or "unnamed"
    return base[-200:] if len(base) > 200 else base


async def _seed_default_scenario_bindings(db: AsyncSession, project_id: str) -> None:
    """新项目自动绑定已存在的内置场景，保证工坊可用。"""
    now = datetime.now().isoformat()
    for row in BUILTIN_SCENARIOS:
        sid = str(row["id"])
        pro = await db.get(ScenarioProfile, sid)
        if not pro:
            continue
        dup = await db.execute(
            select(ProjectScenario).where(
                ProjectScenario.project_id == project_id,
                ProjectScenario.scenario_id == sid,
            )
        )
        if dup.scalar_one_or_none():
            continue
        ver = pro.version if pro.version else BUILTIN_VERSION
        db.add(
            ProjectScenario(
                id=str(uuid.uuid4()),
                project_id=project_id,
                scenario_id=sid,
                scenario_version=ver,
                is_default=1 if sid == "general" else 0,
                enabled=1,
                created_at=now,
                updated_at=now,
            )
        )


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
async def create_project(
    data: ProjectCreate,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
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
        owner_id=effective_uid,
        created_at=datetime.now().isoformat(),
        updated_at=datetime.now().isoformat(),
    )
    db.add(project)
    await db.flush()
    await _seed_default_scenario_bindings(db, project.id)
    await db.commit()
    await db.refresh(project)
    logger.info("project created id=%s owner=%s", project.id, effective_uid[:24])
    return _project_to_response(project)


@router.get("/", response_model=list[ProjectResponse])
async def list_projects(
    status: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    query = select(Project)
    if not is_global_admin_user(effective_uid):
        query = query.where(Project.owner_id == effective_uid)
    if status:
        query = query.where(Project.status == status)
    query = query.order_by(Project.created_at.desc())
    result = await db.execute(query)
    projects = result.scalars().all()
    logger.info("projects list count=%s user_id=%s", len(projects), effective_uid[:24])
    return [_project_to_response(p) for p in projects]


@router.get("/{project_id}", response_model=ProjectResponse)
async def get_project(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    project = await require_project_for_user(db, project_id, effective_uid)
    return _project_to_response(project)


@router.put("/{project_id}", response_model=ProjectResponse)
async def update_project(
    project_id: str,
    data: ProjectUpdate,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    project = await require_project_for_user(db, project_id, effective_uid)
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
async def delete_project(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    project = await require_project_for_user(db, project_id, effective_uid)

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
    req: Request,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    await require_project_for_user(db, project_id, effective_uid)
    rtask = TaskExecuteRequest(
        entrypoint="chat",
        project_id=project_id,
        scenario_id=body.scenario_id,
        user_message=body.user_message,
        stream=False,
        scenario_preset_instructions=body.scenario_preset_instructions,
        scenario_opening_hint=body.scenario_opening_hint,
        overrides=body.overrides,
    )
    payload, snapshot = await assemble_payload(
        db,
        rtask,
        effective_user_id=effective_uid,
        actor_role=viewer_role(req),
    )
    return {"payload": payload.model_dump(mode="json"), "snapshot": snapshot}


class ProjectContextAttachmentItem(BaseModel):
    id: str
    original_filename: str


class ProjectContextOutputItem(BaseModel):
    id: str
    title: str | None
    summary: str | None
    created_at: str | None


class ProjectContextResponse(BaseModel):
    project_id: str
    name: str
    description: Optional[str]
    background: Optional[str]
    audience: Optional[str]
    attachments: list[ProjectContextAttachmentItem]
    recent_outputs: list[ProjectContextOutputItem]


@router.get("/{project_id}/context", response_model=ProjectContextResponse)
async def get_project_context(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    """聚合项目卡、附件列表与近期输出摘要，供对话创作注入 task_input（与设计文档 context 契约对齐）。"""
    project = await require_project_for_user(db, project_id, effective_uid)
    at_rows = (
        await db.execute(
            select(ProjectAttachment)
            .where(ProjectAttachment.project_id == project_id)
            .order_by(ProjectAttachment.created_at.desc())
            .limit(64)
        )
    ).scalars().all()
    attachments = [
        ProjectContextAttachmentItem(id=a.id, original_filename=a.original_filename)
        for a in at_rows
    ]

    out_rows = (
        await db.execute(
            select(OutputAsset)
            .where(OutputAsset.project_id == project_id)
            .order_by(OutputAsset.created_at.desc())
            .limit(12)
        )
    ).scalars().all()
    recent_outputs = [
        ProjectContextOutputItem(
            id=o.id,
            title=o.title,
            summary=(o.summary or (o.content or "")[:240]) or None,
            created_at=o.created_at,
        )
        for o in out_rows
    ]

    return ProjectContextResponse(
        project_id=project.id,
        name=project.name,
        description=project.description,
        background=project.background,
        audience=project.audience,
        attachments=attachments,
        recent_outputs=recent_outputs,
    )


class OutputListItem(BaseModel):
    id: str
    title: str | None
    summary: str | None
    template_id: str | None
    run_id: str | None
    scenario_id: str | None = None
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
    scenario_id: str | None = None
    status: str
    created_at: str | None
    updated_at: str | None
    content_format: str
    content: str


@router.get("/{project_id}/outputs", response_model=list[OutputListItem])
async def list_project_outputs(
    project_id: str,
    scenario_id: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    await require_project_for_user(db, project_id, effective_uid)
    query = select(OutputAsset).where(OutputAsset.project_id == project_id)
    if scenario_id:
        query = query.where(OutputAsset.scenario_id == scenario_id)
    if status:
        query = query.where(OutputAsset.status == status)
    query = query.order_by(OutputAsset.created_at.desc()).limit(min(limit, 500))
    q = await db.execute(query)
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
                scenario_id=getattr(o, "scenario_id", None),
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
    effective_uid: str = Depends(get_effective_user_id),
):
    await require_project_for_user(db, project_id, effective_uid)
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
        scenario_id=getattr(row, "scenario_id", None),
        status=row.status,
        created_at=row.created_at,
        updated_at=row.updated_at,
        content_format=row.content_format or "markdown",
        content=row.content or "",
    )


class RunListItem(BaseModel):
    id: str
    entrypoint: str
    scenario_id: str | None = None
    status: str
    created_at: str | None
    duration_ms: int | None


@router.get("/{project_id}/runs", response_model=list[RunListItem])
async def list_project_runs(
    project_id: str,
    scenario_id: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    await require_project_for_user(db, project_id, effective_uid)
    query = select(OrchestrationRun).where(OrchestrationRun.project_id == project_id)
    if scenario_id:
        query = query.where(OrchestrationRun.scenario_id == scenario_id)
    if status:
        query = query.where(OrchestrationRun.status == status)
    q = await db.execute(
        query.order_by(OrchestrationRun.created_at.desc()).limit(min(limit, 500))
    )
    rows = q.scalars().all()
    return [
        RunListItem(
            id=r.id,
            entrypoint=r.entrypoint,
            scenario_id=getattr(r, "scenario_id", None),
            status=r.status,
            created_at=r.created_at,
            duration_ms=r.duration_ms,
        )
        for r in rows
    ]


# --- 项目附件 ---


class AttachmentListItem(BaseModel):
    id: str
    project_id: str
    original_filename: str
    content_type: str | None
    size_bytes: int
    created_at: str | None


@router.get("/{project_id}/attachments", response_model=list[AttachmentListItem])
async def list_project_attachments(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    await require_project_for_user(db, project_id, effective_uid)
    q = await db.execute(
        select(ProjectAttachment)
        .where(ProjectAttachment.project_id == project_id)
        .order_by(ProjectAttachment.created_at.desc())
    )
    rows = q.scalars().all()
    return [
        AttachmentListItem(
            id=a.id,
            project_id=a.project_id,
            original_filename=a.original_filename,
            content_type=a.content_type,
            size_bytes=a.size_bytes,
            created_at=a.created_at,
        )
        for a in rows
    ]


@router.post("/{project_id}/attachments", response_model=AttachmentListItem)
async def upload_project_attachment(
    project_id: str,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    await require_project_for_user(db, project_id, effective_uid)
    content = await file.read()
    size = len(content)
    if size == 0:
        raise HTTPException(status_code=400, detail="空文件不可上传")
    if size > _MAX_ATTACHMENT_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"文件超过上限 {_MAX_ATTACHMENT_BYTES // (1024 * 1024)} MB",
        )
    aid = str(uuid.uuid4())
    safe_name = _safe_original_filename(file.filename)
    rel = f"{project_id}/{aid}_{safe_name}"
    root = _attachments_root()
    dest = root / project_id / f"{aid}_{safe_name}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(content)
    now = datetime.now().isoformat()
    row = ProjectAttachment(
        id=aid,
        project_id=project_id,
        original_filename=safe_name,
        content_type=file.content_type,
        size_bytes=size,
        stored_path=rel,
        created_at=now,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    logger.info(
        "project_attachment uploaded project=%s id=%s name=%s size=%s",
        project_id,
        aid,
        safe_name,
        size,
    )
    return AttachmentListItem(
        id=row.id,
        project_id=row.project_id,
        original_filename=row.original_filename,
        content_type=row.content_type,
        size_bytes=row.size_bytes,
        created_at=row.created_at,
    )


@router.get("/{project_id}/attachments/{attachment_id}/download")
async def download_project_attachment(
    project_id: str,
    attachment_id: str,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    await require_project_for_user(db, project_id, effective_uid)
    q = await db.execute(
        select(ProjectAttachment).where(
            ProjectAttachment.id == attachment_id,
            ProjectAttachment.project_id == project_id,
        )
    )
    row = q.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Attachment not found")
    path = _attachments_root() / row.stored_path
    if not path.is_file():
        logger.warning(
            "project_attachment missing file project=%s id=%s path=%s",
            project_id,
            attachment_id,
            path,
        )
        raise HTTPException(status_code=404, detail="文件已丢失")
    media = row.content_type or "application/octet-stream"
    return FileResponse(
        path,
        media_type=media,
        filename=row.original_filename,
    )


@router.delete("/{project_id}/attachments/{attachment_id}")
async def delete_project_attachment(
    project_id: str,
    attachment_id: str,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    await require_project_for_user(db, project_id, effective_uid)
    q = await db.execute(
        select(ProjectAttachment).where(
            ProjectAttachment.id == attachment_id,
            ProjectAttachment.project_id == project_id,
        )
    )
    row = q.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Attachment not found")
    path = _attachments_root() / row.stored_path
    try:
        if path.is_file():
            path.unlink()
    except OSError as e:
        logger.warning(
            "project_attachment unlink failed project=%s id=%s err=%s",
            project_id,
            attachment_id,
            e,
        )
    await db.delete(row)
    await db.commit()
    logger.info("project_attachment deleted project=%s id=%s", project_id, attachment_id)
    return {"ok": True}


# --- 项目 ⇄ 场景绑定 ---


class ProjectScenarioItem(BaseModel):
    binding_id: str
    scenario_id: str
    scenario_code: str
    scenario_name: str
    scenario_version: str
    scenario_description: str | None = None
    scenario_status: str = "draft"
    is_default: int
    enabled: int


class ProjectScenarioBind(BaseModel):
    scenario_id: str
    scenario_version: str
    is_default: bool = False


def _project_scenario_item(ps: ProjectScenario, sp: ScenarioProfile) -> ProjectScenarioItem:
    desc = (sp.description or "").strip()
    if len(desc) > 240:
        desc = desc[:239] + "…"
    return ProjectScenarioItem(
        binding_id=ps.id,
        scenario_id=ps.scenario_id,
        scenario_code=sp.code,
        scenario_name=sp.name,
        scenario_version=ps.scenario_version,
        scenario_description=desc or None,
        scenario_status=sp.status or "draft",
        is_default=ps.is_default,
        enabled=ps.enabled,
    )


@router.get("/{project_id}/scenarios", response_model=list[ProjectScenarioItem])
async def list_bound_scenarios(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    await require_project_for_user(db, project_id, effective_uid)
    q = await db.execute(
        select(ProjectScenario, ScenarioProfile)
        .join(ScenarioProfile, ScenarioProfile.id == ProjectScenario.scenario_id)
        .where(ProjectScenario.project_id == project_id)
        .order_by(ProjectScenario.is_default.desc(), ScenarioProfile.name)
    )
    rows = q.all()
    return [_project_scenario_item(ps, sp) for ps, sp in rows]


@router.post("/{project_id}/scenarios", response_model=ProjectScenarioItem)
async def bind_project_scenario(
    project_id: str,
    body: ProjectScenarioBind,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    await require_project_for_user(db, project_id, effective_uid)
    sp = await db.get(ScenarioProfile, body.scenario_id)
    if not sp:
        raise HTTPException(status_code=404, detail="场景不存在")
    st = (sp.status or "draft").strip().lower()
    if st == "disabled":
        raise HTTPException(status_code=400, detail="场景已停用，无法绑定到项目")
    if st != "published":
        raise HTTPException(
            status_code=400,
            detail=f"仅允许绑定已发布（published）场景，当前为 {sp.status or 'draft'}；请先在场景编排中发布",
        )
    if sp.version != body.scenario_version:
        raise HTTPException(
            status_code=409,
            detail=f"场景版本不匹配：当前为 {sp.version}，请求绑定 {body.scenario_version}",
        )
    existing = await db.execute(
        select(ProjectScenario).where(
            ProjectScenario.project_id == project_id,
            ProjectScenario.scenario_id == body.scenario_id,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="该项目已绑定该场景")
    if body.is_default:
        await db.execute(
            update(ProjectScenario)
            .where(ProjectScenario.project_id == project_id)
            .values(is_default=0)
        )
    now = datetime.now().isoformat()
    ps = ProjectScenario(
        id=str(uuid.uuid4()),
        project_id=project_id,
        scenario_id=body.scenario_id,
        scenario_version=body.scenario_version,
        is_default=1 if body.is_default else 0,
        enabled=1,
        created_at=now,
        updated_at=now,
    )
    db.add(ps)
    await db.commit()
    await db.refresh(ps)
    await db.refresh(sp)
    return _project_scenario_item(ps, sp)


@router.delete("/{project_id}/scenarios/{scenario_id}")
async def unbind_project_scenario(
    project_id: str,
    scenario_id: str,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    await require_project_for_user(db, project_id, effective_uid)
    res = await db.execute(
        select(ProjectScenario).where(
            ProjectScenario.project_id == project_id,
            ProjectScenario.scenario_id == scenario_id,
        )
    )
    row = res.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="绑定不存在")
    await db.delete(row)
    await db.commit()
    return {"message": "unbound"}


@router.post("/{project_id}/scenarios/{scenario_id}/default", response_model=ProjectScenarioItem)
async def set_default_project_scenario(
    project_id: str,
    scenario_id: str,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    await require_project_for_user(db, project_id, effective_uid)
    res = await db.execute(
        select(ProjectScenario, ScenarioProfile)
        .join(ScenarioProfile, ScenarioProfile.id == ProjectScenario.scenario_id)
        .where(
            ProjectScenario.project_id == project_id,
            ProjectScenario.scenario_id == scenario_id,
            ProjectScenario.enabled == 1,
        )
    )
    row = res.first()
    if not row:
        raise HTTPException(status_code=404, detail="绑定不存在或未启用")
    ps, sp = row
    await db.execute(
        update(ProjectScenario)
        .where(ProjectScenario.project_id == project_id)
        .values(is_default=0)
    )
    ps.is_default = 1
    ps.updated_at = datetime.now().isoformat()
    await db.commit()
    await db.refresh(ps)
    return _project_scenario_item(ps, sp)


# --- 输出物治理 ---


class OutputVersionCreate(BaseModel):
    content: str | None = None
    title: str | None = None
    scenario_id: str | None = None


@router.post("/{project_id}/outputs/{output_id}/versions", response_model=OutputDetailResponse)
async def create_output_version(
    project_id: str,
    output_id: str,
    body: OutputVersionCreate,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    await require_project_for_user(db, project_id, effective_uid)
    q = await db.execute(
        select(OutputAsset).where(
            OutputAsset.id == output_id,
            OutputAsset.project_id == project_id,
        )
    )
    prev = q.scalar_one_or_none()
    if not prev:
        raise HTTPException(status_code=404, detail="Output not found")
    try:
        vnum = int(prev.version or "1") + 1
    except ValueError:
        vnum = 2
    content = body.content if body.content is not None else (prev.content or "")
    title = body.title if body.title is not None else prev.title
    scen = body.scenario_id if body.scenario_id is not None else getattr(prev, "scenario_id", None)
    now = datetime.now().isoformat()
    new_row = OutputAsset(
        id=str(uuid.uuid4()),
        project_id=project_id,
        scenario_id=scen,
        template_id=prev.template_id,
        run_id=prev.run_id,
        title=title,
        summary=(content or "")[:280],
        content=content,
        content_format=prev.content_format or "markdown",
        version=str(vnum),
        status=prev.status,
        citations_json=prev.citations_json,
        owner_id=(getattr(prev, "owner_id", None) or effective_uid or "default"),
        created_at=now,
        updated_at=now,
    )
    db.add(new_row)
    await db.commit()
    await db.refresh(new_row)
    return OutputDetailResponse(
        id=new_row.id,
        project_id=new_row.project_id,
        title=new_row.title,
        summary=new_row.summary,
        template_id=new_row.template_id,
        run_id=new_row.run_id,
        scenario_id=getattr(new_row, "scenario_id", None),
        status=new_row.status,
        created_at=new_row.created_at,
        updated_at=new_row.updated_at,
        content_format=new_row.content_format or "markdown",
        content=new_row.content or "",
    )


@router.post("/{project_id}/outputs/{output_id}/approve", response_model=OutputDetailResponse)
async def approve_output(
    project_id: str,
    output_id: str,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    await require_project_for_user(db, project_id, effective_uid)
    q = await db.execute(
        select(OutputAsset).where(
            OutputAsset.id == output_id,
            OutputAsset.project_id == project_id,
        )
    )
    row = q.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Output not found")
    row.status = "approved"
    row.updated_at = datetime.now().isoformat()
    await db.commit()
    await db.refresh(row)
    return OutputDetailResponse(
        id=row.id,
        project_id=row.project_id,
        title=row.title,
        summary=row.summary,
        template_id=row.template_id,
        run_id=row.run_id,
        scenario_id=getattr(row, "scenario_id", None),
        status=row.status,
        created_at=row.created_at,
        updated_at=row.updated_at,
        content_format=row.content_format or "markdown",
        content=row.content or "",
    )


@router.post("/{project_id}/outputs/{output_id}/archive", response_model=OutputDetailResponse)
async def archive_output(
    project_id: str,
    output_id: str,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    await require_project_for_user(db, project_id, effective_uid)
    q = await db.execute(
        select(OutputAsset).where(
            OutputAsset.id == output_id,
            OutputAsset.project_id == project_id,
        )
    )
    row = q.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Output not found")
    row.status = "archived"
    row.updated_at = datetime.now().isoformat()
    await db.commit()
    await db.refresh(row)
    return OutputDetailResponse(
        id=row.id,
        project_id=row.project_id,
        title=row.title,
        summary=row.summary,
        template_id=row.template_id,
        run_id=row.run_id,
        scenario_id=getattr(row, "scenario_id", None),
        status=row.status,
        created_at=row.created_at,
        updated_at=row.updated_at,
        content_format=row.content_format or "markdown",
        content=row.content or "",
    )
