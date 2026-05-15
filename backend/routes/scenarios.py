"""场景编排 CRUD、发布、预览。"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import get_db
from backend.models.scenario_profile import ScenarioProfile
from backend.models.template import Template
from backend.schemas.orchestration import TaskExecuteRequest, TaskExecuteOverrides
from backend.services.orchestration_service import assemble_payload

logger = logging.getLogger("tpdx.hermes")

router = APIRouter(prefix="/scenarios", tags=["scenarios"])


def _dump(d: dict[str, Any] | None) -> str:
    return json.dumps(d or {}, ensure_ascii=False)


def _log_knowledge_policy_warnings(kp: dict[str, Any] | None) -> None:
    """可选编排提示：restricted 且无 collections 时记录告警日志。"""
    if not kp:
        return
    mode = kp.get("mode", "restricted")
    cols = kp.get("collections")
    if mode == "restricted" and (not isinstance(cols, list) or len(cols) == 0):
        logger.warning(
            "scenario knowledge_policy: mode=restricted 但 collections 为空，请确认场景知识范围"
        )


class ScenarioCreate(BaseModel):
    code: str
    name: str
    description: str | None = None
    category: str | None = None
    goal: str | None = None
    conversation_mode: str = "task_oriented"
    domain: dict[str, Any] | None = None
    knowledge_policy: dict[str, Any] | None = None
    skills_policy: dict[str, Any] | None = None
    output_policy: dict[str, Any] | None = None
    preset_instructions: str | None = None
    opening_hint: str | None = None


class ScenarioUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    category: str | None = None
    goal: str | None = None
    conversation_mode: str | None = None
    domain: dict[str, Any] | None = None
    knowledge_policy: dict[str, Any] | None = None
    skills_policy: dict[str, Any] | None = None
    output_policy: dict[str, Any] | None = None
    preset_instructions: str | None = None
    opening_hint: str | None = None


class ScenarioContractResponse(BaseModel):
    """供工坊/项目控制台展示的场景合同摘要（与 ScenarioResponse 策略字段一致，体量固定）。"""

    id: str
    code: str
    name: str
    description: str | None
    goal: str | None
    preset_instructions: str | None
    opening_hint: str | None
    knowledge_policy: dict[str, Any]
    skills_policy: dict[str, Any]
    output_policy: dict[str, Any]
    version: str
    status: str


class ScenarioResponse(BaseModel):
    id: str
    code: str
    name: str
    description: str | None
    category: str | None
    goal: str | None
    conversation_mode: str
    domain: dict[str, Any]
    knowledge_policy: dict[str, Any]
    skills_policy: dict[str, Any]
    output_policy: dict[str, Any]
    preset_instructions: str | None
    opening_hint: str | None
    version: str
    status: str
    created_at: str | None
    updated_at: str | None


def _row_to_response(row: ScenarioProfile) -> ScenarioResponse:
    return ScenarioResponse(
        id=row.id,
        code=row.code,
        name=row.name,
        description=row.description,
        category=row.category,
        goal=row.goal,
        conversation_mode=row.conversation_mode,
        domain=json.loads(row.domain_json) if row.domain_json else {},
        knowledge_policy=json.loads(row.knowledge_policy_json) if row.knowledge_policy_json else {},
        skills_policy=json.loads(row.skills_policy_json) if row.skills_policy_json else {},
        output_policy=json.loads(row.output_policy_json) if row.output_policy_json else {},
        preset_instructions=row.preset_instructions,
        opening_hint=row.opening_hint,
        version=row.version,
        status=row.status,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@router.post("/", response_model=ScenarioResponse)
async def create_scenario(body: ScenarioCreate, db: AsyncSession = Depends(get_db)):
    dup = await db.execute(select(ScenarioProfile).where(ScenarioProfile.code == body.code))
    if dup.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="场景编码已存在")
    _log_knowledge_policy_warnings(body.knowledge_policy)
    now = datetime.now().isoformat()
    row = ScenarioProfile(
        id=str(uuid.uuid4()),
        code=body.code.strip(),
        name=body.name.strip(),
        description=body.description,
        category=body.category,
        goal=body.goal,
        conversation_mode=body.conversation_mode or "task_oriented",
        domain_json=_dump(body.domain),
        knowledge_policy_json=_dump(body.knowledge_policy),
        skills_policy_json=_dump(body.skills_policy),
        output_policy_json=_dump(body.output_policy),
        preset_instructions=body.preset_instructions,
        opening_hint=body.opening_hint,
        version="0.0.1",
        status="draft",
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    logger.info("scenario created id=%s code=%s", row.id, row.code)
    return _row_to_response(row)


@router.get("/", response_model=list[ScenarioResponse])
async def list_scenarios(
    status: str | None = None,
    category: str | None = None,
    q: str | None = None,
    db: AsyncSession = Depends(get_db),
):
    query = select(ScenarioProfile).order_by(ScenarioProfile.updated_at.desc())
    if status:
        query = query.where(ScenarioProfile.status == status)
    if category:
        query = query.where(ScenarioProfile.category == category)
    if q:
        like = f"%{q}%"
        query = query.where(
            or_(
                ScenarioProfile.name.like(like),
                ScenarioProfile.code.like(like),
                ScenarioProfile.description.like(like),
            )
        )
    res = await db.execute(query)
    rows = res.scalars().all()
    return [_row_to_response(r) for r in rows]


@router.get("/{scenario_id}/contract", response_model=ScenarioContractResponse)
async def get_scenario_contract(scenario_id: str, db: AsyncSession = Depends(get_db)):
    row = await db.get(ScenarioProfile, scenario_id)
    if not row:
        raise HTTPException(status_code=404, detail="场景不存在")
    return ScenarioContractResponse(
        id=row.id,
        code=row.code,
        name=row.name,
        description=row.description,
        goal=row.goal,
        preset_instructions=row.preset_instructions,
        opening_hint=row.opening_hint,
        knowledge_policy=json.loads(row.knowledge_policy_json) if row.knowledge_policy_json else {},
        skills_policy=json.loads(row.skills_policy_json) if row.skills_policy_json else {},
        output_policy=json.loads(row.output_policy_json) if row.output_policy_json else {},
        version=row.version,
        status=row.status,
    )


@router.get("/{scenario_id}", response_model=ScenarioResponse)
async def get_scenario(scenario_id: str, db: AsyncSession = Depends(get_db)):
    row = await db.get(ScenarioProfile, scenario_id)
    if not row:
        raise HTTPException(status_code=404, detail="场景不存在")
    return _row_to_response(row)


@router.put("/{scenario_id}", response_model=ScenarioResponse)
async def update_scenario(
    scenario_id: str,
    body: ScenarioUpdate,
    db: AsyncSession = Depends(get_db),
):
    row = await db.get(ScenarioProfile, scenario_id)
    if not row:
        raise HTTPException(status_code=404, detail="场景不存在")
    data = body.model_dump(exclude_unset=True)
    if "domain" in data:
        row.domain_json = _dump(data.pop("domain"))
    if "knowledge_policy" in data:
        kp = data["knowledge_policy"]
        _log_knowledge_policy_warnings(kp if isinstance(kp, dict) else None)
        row.knowledge_policy_json = _dump(data.pop("knowledge_policy"))
    if "skills_policy" in data:
        row.skills_policy_json = _dump(data.pop("skills_policy"))
    if "output_policy" in data:
        row.output_policy_json = _dump(data.pop("output_policy"))
    for k, v in data.items():
        setattr(row, k, v)
    row.updated_at = datetime.now().isoformat()
    await db.commit()
    await db.refresh(row)
    logger.info("scenario updated id=%s", scenario_id)
    return _row_to_response(row)


def _parse_policy_field(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        v = json.loads(raw)
        return v if isinstance(v, dict) else {}
    except json.JSONDecodeError:
        return {}


async def _ensure_scenario_publishable(db: AsyncSession, row: ScenarioProfile) -> None:
    """发布前合同校验：技能白名单、输出策略与模板引用须满足工坊可执行条件。"""
    skills = _parse_policy_field(row.skills_policy_json)
    allowed = skills.get("allowed")
    if not isinstance(allowed, list):
        allowed = []
    allowed_n = [str(x).strip() for x in allowed if str(x).strip()]
    if not allowed_n:
        raise HTTPException(
            status_code=400,
            detail="发布前校验失败：skills_policy.allowed 须为非空列表（工坊依赖合同内技能白名单）",
        )

    output = _parse_policy_field(row.output_policy_json)
    req_raw = output.get("required_sections")
    if not isinstance(req_raw, list):
        req_raw = []
    sections = [str(s).strip() for s in req_raw if str(s).strip()]
    must_follow = bool(output.get("must_follow_template", False))
    if must_follow and not sections:
        raise HTTPException(
            status_code=400,
            detail="发布前校验失败：已设置 must_follow_template=true 时，required_sections 不能为空",
        )

    tid = output.get("template_id")
    if tid is not None and str(tid).strip():
        tid_s = str(tid).strip()
        tpl = await db.get(Template, tid_s)
        if not tpl:
            raise HTTPException(
                status_code=400,
                detail=f"发布前校验失败：output_policy.template_id 不存在于模板库（{tid_s}）",
            )


def _bump_version(v: str) -> str:
    parts = v.split(".")
    if len(parts) == 3 and all(p.isdigit() for p in parts):
        return f"{parts[0]}.{parts[1]}.{int(parts[2]) + 1}"
    if len(parts) == 1 and parts[0].isdigit():
        return str(int(parts[0]) + 1)
    return v + ".1"


@router.post("/{scenario_id}/publish", response_model=ScenarioResponse)
async def publish_scenario(scenario_id: str, db: AsyncSession = Depends(get_db)):
    row = await db.get(ScenarioProfile, scenario_id)
    if not row:
        raise HTTPException(status_code=404, detail="场景不存在")
    await _ensure_scenario_publishable(db, row)
    row.version = _bump_version(row.version)
    row.status = "published"
    row.updated_at = datetime.now().isoformat()
    await db.commit()
    await db.refresh(row)
    logger.info("scenario published id=%s version=%s", scenario_id, row.version)
    return _row_to_response(row)


@router.post("/{scenario_id}/disable", response_model=ScenarioResponse)
async def disable_scenario(scenario_id: str, db: AsyncSession = Depends(get_db)):
    row = await db.get(ScenarioProfile, scenario_id)
    if not row:
        raise HTTPException(status_code=404, detail="场景不存在")
    row.status = "disabled"
    row.updated_at = datetime.now().isoformat()
    await db.commit()
    await db.refresh(row)
    return _row_to_response(row)


class ScenarioPreviewBody(BaseModel):
    project_id: str | None = None
    user_message: str = Field(default="（编排预览）")
    overrides: TaskExecuteOverrides | None = None


@router.post("/{scenario_id}/preview")
async def preview_scenario(
    scenario_id: str,
    body: ScenarioPreviewBody,
    db: AsyncSession = Depends(get_db),
):
    row = await db.get(ScenarioProfile, scenario_id)
    if not row:
        raise HTTPException(status_code=404, detail="场景不存在")
    req = TaskExecuteRequest(
        entrypoint="chat",
        project_id=body.project_id,
        scenario_id=scenario_id,
        user_message=body.user_message,
        stream=False,
        overrides=body.overrides,
    )
    payload, snapshot = await assemble_payload(db, req)
    return {
        "scenario_id": scenario_id,
        "scenario_version": row.version,
        "payload": payload.model_dump(mode="json"),
        "snapshot": snapshot,
    }
