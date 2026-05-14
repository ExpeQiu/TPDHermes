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
from backend.schemas.orchestration import TaskExecuteRequest, TaskExecuteOverrides
from backend.services.orchestration_service import assemble_payload

logger = logging.getLogger("tpdx.hermes")

router = APIRouter(prefix="/scenarios", tags=["scenarios"])


def _dump(d: dict[str, Any] | None) -> str:
    return json.dumps(d or {}, ensure_ascii=False)


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
