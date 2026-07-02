from fastapi import APIRouter, HTTPException, Depends, UploadFile, File, Request, Query
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
from backend.services.project_access import list_visible_project_filter, project_owner_id, require_project_for_user
from backend.services.rbac import require_system_admin
from backend.services.project_member_service import (
    ensure_owner_membership,
    get_project_role,
    list_project_members,
    remove_project_member,
    upsert_project_member,
)
from backend.services.project_kb import project_kb_collection
from backend.services.project_kb_ingest import (
    schedule_ingest_attachment,
    schedule_ingest_output,
    schedule_output_kb_visibility,
    ingest_project_attachment,
    remove_attachment_from_kb,
)
from backend.services.user_directory_service import list_registered_users
from backend.services.user_identity import get_effective_user_id, viewer_role
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


def _ocr_error_detail(code: str) -> str:
    mapping = {
        "ocr_disabled": "图片 OCR 功能已关闭",
        "ocr_upstream_not_configured": "OCR 服务未配置",
        "ocr_vision_not_configured": (
            "图片 OCR 需配置视觉模型：请设置 OPENROUTER_API_KEY，"
            "或 IMAGE_OCR_API_URL + IMAGE_OCR_API_KEY（勿使用 Hermes 对话网关）"
        ),
        "ocr_agent_gateway_not_supported": (
            "图片 OCR 不能走 Hermes 对话网关，请配置 OPENROUTER_API_KEY 或 IMAGE_OCR_API_URL"
        ),
        "ocr_vision_unavailable": "视觉模型未能读取图片内容，请检查 OCR 模型配置或更换图片后重试",
        "ocr_tesseract_not_installed": "Tesseract Python 依赖未安装（pytesseract/Pillow）",
        "ocr_tesseract_binary_missing": "未找到 Tesseract 可执行文件，请安装 tesseract-ocr 及中文语言包",
        "ocr_empty_text": "未从图片中识别到文字",
        "empty_image": "图片内容为空",
        "image_too_large": "图片过大，无法 OCR",
    }
    if code in mapping:
        return mapping[code]
    if code.startswith("ocr_upstream_http_"):
        return f"OCR 服务返回错误（{code.split('_')[-1]}）"
    if code.startswith("ocr_upstream_error:"):
        return "OCR 服务不可用，请稍后重试"
    if code.startswith("ocr_tesseract_failed:"):
        return f"Tesseract 识别失败：{code.split(':', 1)[-1][:120]}"
    if code.startswith("ocr_image_decode_failed:"):
        return "图片格式无法解析，请更换图片后重试"
    return f"图片 OCR 失败：{code}"


async def _prepare_attachment_payload(
    *,
    content: bytes,
    filename: str | None,
    content_type: str | None,
    ocr: bool,
) -> tuple[bytes, str, str | None]:
    from backend.services.image_ocr import (
        ImageOcrError,
        image_md_filename,
        image_ocr_enabled,
        is_image_attachment,
        ocr_image_to_markdown,
    )

    safe_name = _safe_original_filename(filename)
    ct = (content_type or "").strip() or None
    if not ocr or not is_image_attachment(safe_name, ct):
        return content, safe_name, ct
    if not image_ocr_enabled():
        raise HTTPException(status_code=503, detail=_ocr_error_detail("ocr_disabled"))
    try:
        md_body = await ocr_image_to_markdown(
            content,
            content_type=ct or "image/png",
            filename=safe_name,
        )
    except ImageOcrError as exc:
        logger.warning(
            "project_attachment ocr failed name=%s err=%s",
            safe_name,
            exc,
        )
        raise HTTPException(status_code=422, detail=_ocr_error_detail(str(exc))) from exc
    md_name = _safe_original_filename(image_md_filename(safe_name))
    logger.info(
        "project_attachment ocr converted name=%s -> %s chars=%s",
        safe_name,
        md_name,
        len(md_body),
    )
    return md_body.encode("utf-8"), md_name, "text/markdown"


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
    knowledge_policy_id: Optional[str] = None


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    background: Optional[str] = None
    audience: Optional[str] = None
    deadline: Optional[str] = None
    constraints: Optional[dict] = None
    status: Optional[str] = None
    knowledge_policy_id: Optional[str] = None


class ProjectResponse(BaseModel):
    id: str
    name: str
    description: Optional[str]
    background: Optional[str]
    audience: Optional[str]
    deadline: Optional[str]
    constraints: Optional[dict]
    status: str
    knowledge_policy_id: Optional[str] = None
    created_at: str
    updated_at: str
    my_role: Optional[str] = None


class ProjectMemberIn(BaseModel):
    user_id: str
    role: str = "viewer"


class ProjectMemberUpdate(BaseModel):
    role: str


class ProjectMemberResponse(BaseModel):
    id: str
    project_id: str
    user_id: str
    role: str
    created_at: str
    updated_at: str


class RegisteredUserResponse(BaseModel):
    user_id: str
    display_name: str
    avatar_initial: str
    platform_role: str | None = None
    platform_role_label: str | None = None


def _project_to_response(project: Project, *, my_role: str | None = None) -> ProjectResponse:
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
        knowledge_policy_id=project.knowledge_policy_id,
        created_at=project.created_at,
        updated_at=project.updated_at,
        my_role=my_role,
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
        knowledge_policy_id=data.knowledge_policy_id,
        owner_id=effective_uid,
        created_at=datetime.now().isoformat(),
        updated_at=datetime.now().isoformat(),
    )
    db.add(project)
    await db.flush()
    await ensure_owner_membership(db, project_id=project.id, owner_user_id=effective_uid)
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
    visibility = await list_visible_project_filter(db, effective_uid)
    if visibility is not None:
        query = query.where(visibility)
    if status:
        query = query.where(Project.status == status)
    query = query.order_by(Project.created_at.desc())
    result = await db.execute(query)
    projects = result.scalars().all()
    out: list[ProjectResponse] = []
    for project in projects:
        role = await get_project_role(db, project_id=project.id, user_id=effective_uid, project=project)
        out.append(_project_to_response(project, my_role=role))
    logger.info("projects list count=%s user_id=%s", len(out), effective_uid[:24])
    return out


@router.get("/{project_id}", response_model=ProjectResponse)
async def get_project(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    project = await require_project_for_user(db, project_id, effective_uid)
    role = await get_project_role(db, project_id=project_id, user_id=effective_uid, project=project)
    return _project_to_response(project, my_role=role)


@router.put("/{project_id}", response_model=ProjectResponse)
async def update_project(
    project_id: str,
    data: ProjectUpdate,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    project = await require_project_for_user(db, project_id, effective_uid, min_perm="write")
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
    project = await require_project_for_user(db, project_id, effective_uid, min_perm="delete")
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
    ingest_status: str | None = None


class ProjectContextOutputItem(BaseModel):
    id: str
    title: str | None
    summary: str | None
    created_at: str | None
    status: str | None = None
    kb_indexed: bool = False


class ProjectContextKbStats(BaseModel):
    collection: str
    attachments_indexed: int = 0
    outputs_indexed: int = 0


class ProjectContextResponse(BaseModel):
    project_id: str
    name: str
    description: Optional[str]
    background: Optional[str]
    audience: Optional[str]
    attachments: list[ProjectContextAttachmentItem]
    recent_outputs: list[ProjectContextOutputItem]
    kb_stats: ProjectContextKbStats | None = None


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
        ProjectContextAttachmentItem(
            id=a.id,
            original_filename=a.original_filename,
            ingest_status=getattr(a, "ingest_status", None),
        )
        for a in at_rows
    ]

    att_indexed = sum(1 for a in at_rows if (getattr(a, "ingest_status", None) or "") == "ingested")

    out_rows = (
        await db.execute(
            select(OutputAsset)
            .where(
                OutputAsset.project_id == project_id,
                OutputAsset.status != "archived",
            )
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
            status=o.status,
            kb_indexed=(getattr(o, "kb_ingest_status", None) or "") == "ingested",
        )
        for o in out_rows
    ]
    out_indexed = sum(
        1 for o in out_rows if (getattr(o, "kb_ingest_status", None) or "") == "ingested"
    )

    kb_stats = ProjectContextKbStats(
        collection=project_kb_collection(project_id),
        attachments_indexed=att_indexed,
        outputs_indexed=out_indexed,
    )

    return ProjectContextResponse(
        project_id=project.id,
        name=project.name,
        description=project.description,
        background=project.background,
        audience=project.audience,
        attachments=attachments,
        recent_outputs=recent_outputs,
        kb_stats=kb_stats,
    )


class OutputListItem(BaseModel):
    id: str
    title: str | None
    summary: str | None
    template_id: str | None
    run_id: str | None
    scenario_id: str | None = None
    entrypoint: str | None = None
    status: str
    created_at: str | None
    content_preview: str
    kb_ingest_status: str | None = None
    kb_doc_id: str | None = None
    kb_chunk_count: int | None = None
    user_message: str | None = None


class OutputDetailResponse(BaseModel):
    id: str
    project_id: str
    title: str | None
    summary: str | None
    template_id: str | None
    run_id: str | None
    scenario_id: str | None = None
    entrypoint: str | None = None
    status: str
    created_at: str | None
    updated_at: str | None
    content_format: str
    content: str
    user_message: str | None = None


async def _entrypoint_map_for_runs(
    db: AsyncSession, run_ids: list[str]
) -> dict[str, str]:
    if not run_ids:
        return {}
    q = await db.execute(
        select(OrchestrationRun.id, OrchestrationRun.entrypoint).where(
            OrchestrationRun.id.in_(run_ids)
        )
    )
    return {row[0]: row[1] for row in q.all() if row[0] and row[1]}


def _user_message_from_request_json(raw: str | None) -> str | None:
    if not raw:
        return None
    try:
        data = json.loads(raw)
        if not isinstance(data, dict):
            return None
        msg = str(data.get("user_message") or "").strip()
        return msg or None
    except json.JSONDecodeError:
        return None


async def _run_meta_for_outputs(
    db: AsyncSession, run_ids: list[str]
) -> dict[str, dict[str, str | None]]:
    if not run_ids:
        return {}
    q = await db.execute(
        select(
            OrchestrationRun.id,
            OrchestrationRun.entrypoint,
            OrchestrationRun.request_json,
        ).where(OrchestrationRun.id.in_(run_ids))
    )
    out: dict[str, dict[str, str | None]] = {}
    for run_id, entrypoint, request_json in q.all():
        if not run_id:
            continue
        out[str(run_id)] = {
            "entrypoint": str(entrypoint or "").strip() or None,
            "user_message": _user_message_from_request_json(request_json),
        }
    return out


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
    else:
        query = query.where(OutputAsset.status != "archived")
    query = query.order_by(OutputAsset.created_at.desc()).limit(min(limit, 500))
    q = await db.execute(query)
    rows = q.scalars().all()
    run_ids = [o.run_id for o in rows if o.run_id]
    run_meta = await _run_meta_for_outputs(db, run_ids)
    out: list[OutputListItem] = []
    for o in rows:
        preview = (o.content or "")[:200]
        meta = run_meta.get(o.run_id or "", {})
        out.append(
            OutputListItem(
                id=o.id,
                title=o.title,
                summary=o.summary,
                template_id=o.template_id,
                run_id=o.run_id,
                scenario_id=getattr(o, "scenario_id", None),
                entrypoint=meta.get("entrypoint") if o.run_id else None,
                status=o.status,
                created_at=o.created_at,
                content_preview=preview,
                kb_ingest_status=getattr(o, "kb_ingest_status", None),
                kb_doc_id=getattr(o, "kb_doc_id", None),
                kb_chunk_count=getattr(o, "kb_chunk_count", None),
                user_message=meta.get("user_message") if o.run_id else None,
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
    entrypoint: str | None = None
    user_message: str | None = None
    if row.run_id:
        meta = (await _run_meta_for_outputs(db, [row.run_id])).get(row.run_id, {})
        entrypoint = meta.get("entrypoint")
        user_message = meta.get("user_message")
    return OutputDetailResponse(
        id=row.id,
        project_id=row.project_id,
        title=row.title,
        summary=row.summary,
        template_id=row.template_id,
        run_id=row.run_id,
        scenario_id=getattr(row, "scenario_id", None),
        entrypoint=entrypoint,
        status=row.status,
        created_at=row.created_at,
        updated_at=row.updated_at,
        content_format=row.content_format or "markdown",
        content=row.content or "",
        user_message=user_message,
    )


class RunListItem(BaseModel):
    id: str
    entrypoint: str
    scenario_id: str | None = None
    status: str
    created_at: str | None
    duration_ms: int | None
    execution_mode: str | None = None
    tool_capture_hit: bool | None = None


def _run_observability_from_metadata(raw: str | None) -> tuple[str | None, bool | None]:
    if not raw:
        return None, None
    try:
        meta = json.loads(raw)
    except json.JSONDecodeError:
        return None, None
    if not isinstance(meta, dict):
        return None, None
    mode = meta.get("execution_mode")
    hit = meta.get("tool_capture_hit")
    return (
        mode if isinstance(mode, str) else None,
        hit if isinstance(hit, bool) else None,
    )


@router.get("/{project_id}/runs", response_model=list[RunListItem])
async def list_project_runs(
    project_id: str,
    scenario_id: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
    _admin_role: str = Depends(require_system_admin()),
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
    items: list[RunListItem] = []
    for r in rows:
        exec_mode, capture_hit = _run_observability_from_metadata(r.response_metadata_json)
        items.append(
            RunListItem(
                id=r.id,
                entrypoint=r.entrypoint,
                scenario_id=getattr(r, "scenario_id", None),
                status=r.status,
                created_at=r.created_at,
                duration_ms=r.duration_ms,
                execution_mode=exec_mode,
                tool_capture_hit=capture_hit,
            )
        )
    return items


# --- 项目附件 ---


class AttachmentListItem(BaseModel):
    id: str
    project_id: str
    original_filename: str
    content_type: str | None
    size_bytes: int
    created_at: str | None
    ingest_status: str | None = None
    kb_doc_id: str | None = None
    chunk_count: int | None = None
    ingest_error: str | None = None
    ingested_at: str | None = None


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
            ingest_status=getattr(a, "ingest_status", None),
            kb_doc_id=getattr(a, "kb_doc_id", None),
            chunk_count=getattr(a, "chunk_count", None),
            ingest_error=getattr(a, "ingest_error", None),
            ingested_at=getattr(a, "ingested_at", None),
        )
        for a in rows
    ]


@router.post("/{project_id}/attachments", response_model=AttachmentListItem)
async def upload_project_attachment(
    project_id: str,
    file: UploadFile = File(...),
    ocr: bool = Query(False, description="图片 OCR 后保存为 Markdown 附件"),
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    await require_project_for_user(db, project_id, effective_uid, min_perm="write")
    raw_content = await file.read()
    size = len(raw_content)
    if size == 0:
        raise HTTPException(status_code=400, detail="空文件不可上传")
    if size > _MAX_ATTACHMENT_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"文件超过上限 {_MAX_ATTACHMENT_BYTES // (1024 * 1024)} MB",
        )
    content, safe_name, content_type = await _prepare_attachment_payload(
        content=raw_content,
        filename=file.filename,
        content_type=file.content_type,
        ocr=ocr,
    )
    size = len(content)
    aid = str(uuid.uuid4())
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
        content_type=content_type or file.content_type,
        size_bytes=size,
        stored_path=rel,
        created_at=now,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    logger.info(
        "project_attachment uploaded project=%s id=%s name=%s size=%s ocr=%s",
        project_id,
        aid,
        safe_name,
        size,
        ocr,
    )
    schedule_ingest_attachment(aid)
    return AttachmentListItem(
        id=row.id,
        project_id=row.project_id,
        original_filename=row.original_filename,
        content_type=row.content_type,
        size_bytes=row.size_bytes,
        created_at=row.created_at,
        ingest_status=getattr(row, "ingest_status", None),
        kb_doc_id=getattr(row, "kb_doc_id", None),
        chunk_count=getattr(row, "chunk_count", None),
        ingest_error=getattr(row, "ingest_error", None),
        ingested_at=getattr(row, "ingested_at", None),
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
    await require_project_for_user(db, project_id, effective_uid, min_perm="write")
    q = await db.execute(
        select(ProjectAttachment).where(
            ProjectAttachment.id == attachment_id,
            ProjectAttachment.project_id == project_id,
        )
    )
    row = q.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Attachment not found")
    await remove_attachment_from_kb(attachment_id)
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


@router.post("/{project_id}/attachments/{attachment_id}/reingest")
async def reingest_project_attachment(
    project_id: str,
    attachment_id: str,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    await require_project_for_user(db, project_id, effective_uid, min_perm="write")
    q = await db.execute(
        select(ProjectAttachment).where(
            ProjectAttachment.id == attachment_id,
            ProjectAttachment.project_id == project_id,
        )
    )
    row = q.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Attachment not found")
    result = await ingest_project_attachment(attachment_id)
    if not result.ok:
        raise HTTPException(status_code=502, detail=result.message or "ingest_failed")
    return {
        "ok": True,
        "kb_doc_id": result.doc_id,
        "chunk_count": result.chunk_count,
        "collection": result.collection,
    }


# --- 项目文件统一视图（项目共创） ---


class ProjectFileListResponse(BaseModel):
    items: list[dict]


class FileActionApplyBody(BaseModel):
    session_id: str | None = None
    message_id: str | None = None
    proposal_id: str
    action: dict


@router.get("/{project_id}/files", response_model=ProjectFileListResponse)
async def list_unified_project_files(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    await require_project_for_user(db, project_id, effective_uid)
    from backend.services.project_files_service import list_project_files

    items = await list_project_files(db, project_id)
    return ProjectFileListResponse(items=items)


@router.get("/{project_id}/files/{file_id}")
async def get_unified_project_file(
    project_id: str,
    file_id: str,
    kind: str = "output",
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    await require_project_for_user(db, project_id, effective_uid)
    from backend.services.project_files_service import get_project_file_detail

    detail = await get_project_file_detail(db, project_id, file_id, kind.strip())
    if not detail:
        raise HTTPException(status_code=404, detail="File not found")
    return detail


@router.get("/{project_id}/files/{file_id}/versions")
async def list_unified_project_file_versions(
    project_id: str,
    file_id: str,
    kind: str = "output",
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    await require_project_for_user(db, project_id, effective_uid)
    from backend.services.project_files_service import list_output_versions

    if kind.strip() != "output":
        return {"items": []}
    items = await list_output_versions(db, project_id, file_id)
    return {"items": items}


@router.get("/{project_id}/outputs/{output_id}/versions")
async def list_output_versions_by_id(
    project_id: str,
    output_id: str,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    await require_project_for_user(db, project_id, effective_uid)
    from backend.services.project_files_service import list_output_versions

    items = await list_output_versions(db, project_id, output_id)
    return {"items": items}


@router.post("/{project_id}/file-actions/apply")
async def apply_project_file_action(
    project_id: str,
    body: FileActionApplyBody,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    await require_project_for_user(db, project_id, effective_uid, min_perm="write")
    from backend.services.file_action_service import apply_file_action

    try:
        result = await apply_file_action(
            db,
            project_id,
            effective_uid=effective_uid,
            action=body.action,
            session_id=body.session_id,
            message_id=body.message_id,
            proposal_id=body.proposal_id,
        )
        return result
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


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


class ProjectScenarioVersionSync(BaseModel):
    scenario_version: str


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
    await require_project_for_user(db, project_id, effective_uid, min_perm="write")
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


@router.patch("/{project_id}/scenarios/{scenario_id}/version", response_model=ProjectScenarioItem)
async def sync_project_scenario_version(
    project_id: str,
    scenario_id: str,
    body: ProjectScenarioVersionSync,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    """将已绑定场景的版本钉选同步到当前已发布版本。"""
    await require_project_for_user(db, project_id, effective_uid, min_perm="write")
    sp = await db.get(ScenarioProfile, scenario_id)
    if not sp:
        raise HTTPException(status_code=404, detail="场景不存在")
    st = (sp.status or "draft").strip().lower()
    if st != "published":
        raise HTTPException(
            status_code=400,
            detail=f"仅允许同步已发布场景版本，当前为 {sp.status or 'draft'}",
        )
    if sp.version != body.scenario_version:
        raise HTTPException(
            status_code=409,
            detail=f"场景版本不匹配：当前为 {sp.version}，请求同步 {body.scenario_version}",
        )
    res = await db.execute(
        select(ProjectScenario).where(
            ProjectScenario.project_id == project_id,
            ProjectScenario.scenario_id == scenario_id,
            ProjectScenario.enabled == 1,
        )
    )
    row = res.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="绑定不存在或未启用")
    if row.scenario_version == body.scenario_version:
        return _project_scenario_item(row, sp)
    row.scenario_version = body.scenario_version
    row.updated_at = datetime.now().isoformat()
    await db.commit()
    await db.refresh(row)
    await db.refresh(sp)
    logger.info(
        "project scenario version synced project=%s scenario=%s version=%s",
        project_id,
        scenario_id,
        body.scenario_version,
    )
    return _project_scenario_item(row, sp)


@router.delete("/{project_id}/scenarios/{scenario_id}")
async def unbind_project_scenario(
    project_id: str,
    scenario_id: str,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    await require_project_for_user(db, project_id, effective_uid, min_perm="write")
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
    await require_project_for_user(db, project_id, effective_uid, min_perm="write")
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


class ChatOutputDepositRequest(BaseModel):
    content: str
    title: str | None = None
    run_id: str | None = None
    scenario_id: str | None = None
    session_id: str | None = None
    message_id: str | None = None


@router.post("/{project_id}/outputs/deposit-from-chat", response_model=OutputDetailResponse)
async def deposit_chat_output(
    project_id: str,
    body: ChatOutputDepositRequest,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    """用户确认后将对话助手正文写入项目输出（对话类）。"""
    await require_project_for_user(db, project_id, effective_uid, min_perm="write")
    content = (body.content or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="正文不能为空")

    run_id = (body.run_id or "").strip() or None
    scenario_id = (body.scenario_id or "").strip() or None
    title = (body.title or "").strip() or "对话输出"
    run: OrchestrationRun | None = None

    if run_id:
        run = await db.get(OrchestrationRun, run_id)
        if not run:
            raise HTTPException(status_code=404, detail="编排 run 不存在")
        if run.project_id and str(run.project_id) != project_id:
            raise HTTPException(status_code=400, detail="run 与项目不匹配")
        if not scenario_id:
            scenario_id = run.scenario_id

    now = datetime.now().isoformat()
    row: OutputAsset

    if run_id:
        q = await db.execute(
            select(OutputAsset).where(
                OutputAsset.project_id == project_id,
                OutputAsset.run_id == run_id,
            )
        )
        existing = q.scalar_one_or_none()
        if existing:
            existing.content = content
            existing.summary = content[:280]
            existing.title = title
            existing.updated_at = now
            existing.status = "draft"
            await db.commit()
            await db.refresh(existing)
            schedule_ingest_output(existing.id)
            logger.info(
                "[chat-output-deposit] updated output_id=%s run_id=%s project_id=%s message_id=%s",
                existing.id,
                run_id,
                project_id,
                body.message_id,
            )
            meta = (await _run_meta_for_outputs(db, [run_id])).get(run_id, {})
            return OutputDetailResponse(
                id=existing.id,
                project_id=existing.project_id,
                title=existing.title,
                summary=existing.summary,
                template_id=existing.template_id,
                run_id=existing.run_id,
                scenario_id=getattr(existing, "scenario_id", None),
                entrypoint=meta.get("entrypoint"),
                status=existing.status,
                created_at=existing.created_at,
                updated_at=existing.updated_at,
                content_format=existing.content_format or "markdown",
                content=existing.content or "",
                user_message=meta.get("user_message"),
            )

    row = OutputAsset(
        id=str(uuid.uuid4()),
        project_id=project_id,
        scenario_id=scenario_id,
        run_id=run_id,
        title=title,
        summary=content[:280],
        content=content,
        content_format="markdown",
        status="draft",
        owner_id=effective_uid or "default",
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    schedule_ingest_output(row.id)
    logger.info(
        "[chat-output-deposit] created output_id=%s run_id=%s project_id=%s message_id=%s session_id=%s",
        row.id,
        run_id,
        project_id,
        body.message_id,
        body.session_id,
    )
    meta = (await _run_meta_for_outputs(db, [run_id])).get(run_id or "", {}) if run_id else {}
    return OutputDetailResponse(
        id=row.id,
        project_id=row.project_id,
        title=row.title,
        summary=row.summary,
        template_id=row.template_id,
        run_id=row.run_id,
        scenario_id=getattr(row, "scenario_id", None),
        entrypoint=meta.get("entrypoint") if run_id else "chat",
        status=row.status,
        created_at=row.created_at,
        updated_at=row.updated_at,
        content_format=row.content_format or "markdown",
        content=row.content or "",
        user_message=meta.get("user_message") if run_id else None,
    )


@router.post("/{project_id}/outputs/{output_id}/versions", response_model=OutputDetailResponse)
async def create_output_version(
    project_id: str,
    output_id: str,
    body: OutputVersionCreate,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    await require_project_for_user(db, project_id, effective_uid, min_perm="write")
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
    schedule_ingest_output(new_row.id)
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
    await require_project_for_user(db, project_id, effective_uid, min_perm="write")
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
    schedule_output_kb_visibility(row.id, published=True)
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
    await require_project_for_user(db, project_id, effective_uid, min_perm="write")
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
    schedule_output_kb_visibility(row.id, published=False)
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


@router.get("/{project_id}/members", response_model=list[ProjectMemberResponse])
async def list_project_members_api(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    await require_project_for_user(db, project_id, effective_uid, min_perm="read")
    rows = await list_project_members(db, project_id)
    return [
        ProjectMemberResponse(
            id=row.id,
            project_id=row.project_id,
            user_id=row.user_id,
            role=row.role,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )
        for row in rows
    ]


@router.get("/{project_id}/registered-users", response_model=list[RegisteredUserResponse])
async def list_registered_users_api(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    await require_project_for_user(db, project_id, effective_uid, min_perm="manage_members")
    rows = await list_registered_users(db)
    return [RegisteredUserResponse(**row) for row in rows]


@router.post("/{project_id}/members", response_model=ProjectMemberResponse)
async def add_project_member_api(
    project_id: str,
    body: ProjectMemberIn,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    project = await require_project_for_user(db, project_id, effective_uid, min_perm="manage_members")
    row = await upsert_project_member(
        db,
        project_id=project_id,
        member_user_id=body.user_id,
        role=body.role,
    )
    return ProjectMemberResponse(
        id=row.id,
        project_id=row.project_id,
        user_id=row.user_id,
        role=row.role,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.patch("/{project_id}/members/{member_user_id}", response_model=ProjectMemberResponse)
async def update_project_member_api(
    project_id: str,
    member_user_id: str,
    body: ProjectMemberUpdate,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    project = await require_project_for_user(db, project_id, effective_uid, min_perm="manage_members")
    row = await upsert_project_member(
        db,
        project_id=project_id,
        member_user_id=member_user_id,
        role=body.role,
    )
    return ProjectMemberResponse(
        id=row.id,
        project_id=row.project_id,
        user_id=row.user_id,
        role=row.role,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.delete("/{project_id}/members/{member_user_id}")
async def remove_project_member_api(
    project_id: str,
    member_user_id: str,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    project = await require_project_for_user(db, project_id, effective_uid, min_perm="manage_members")
    await remove_project_member(
        db,
        project_id=project_id,
        member_user_id=member_user_id,
        owner_user_id=project_owner_id(project),
    )
    return {"ok": True}
