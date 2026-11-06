from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import get_db
from backend.services.knowledge_policy_store import (
    create_policy,
    get_policy,
    get_policy_by_code,
    list_policies,
    list_policy_versions,
    policy_to_dict,
    transition_policy_status,
    update_policy,
)
from backend.services.rbac import require_feature
from backend.services.user_identity import get_effective_user_id

router = APIRouter(
    prefix="/kb/policies",
    tags=["knowledge_policies"],
    dependencies=[Depends(require_feature("knowledge"))],
)


class KnowledgePolicyCreate(BaseModel):
    code: str
    name: str
    description: str | None = None
    config: dict[str, Any] | None = None
    change_note: str | None = None


class KnowledgePolicyUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    config: dict[str, Any] | None = None
    change_note: str | None = None


class AutoGovernBody(BaseModel):
    dry_run: bool = True
    consult_agent: bool = False


class GovernScheduleSave(BaseModel):
    enabled: bool = False
    cadence: str = "daily"
    run_time: str = "02:00"
    weekday: int = 0
    month_day: int = 1
    agent_batch: int = 20
    policy_ids: list[str] = []


@router.get("/govern-schedule")
async def kb_govern_schedule_get(db: AsyncSession = Depends(get_db)):
    from backend.services.kb_govern_settings import get_or_create_schedule, schedule_view

    row = await get_or_create_schedule(db)
    await db.commit()
    return schedule_view(row)


@router.put("/govern-schedule")
async def kb_govern_schedule_save(body: GovernScheduleSave, db: AsyncSession = Depends(get_db)):
    from backend.services.kb_govern_settings import save_schedule, schedule_view

    if body.cadence not in {"daily", "weekly", "monthly"}:
        raise HTTPException(status_code=400, detail="周期只能是每日、每周或每月")
    if body.agent_batch < 1 or body.agent_batch > 50:
        raise HTTPException(status_code=400, detail="每批文档数需在 1 到 50 之间")
    row = await save_schedule(
        db,
        enabled=body.enabled,
        cadence=body.cadence,
        run_time=body.run_time,
        weekday=body.weekday,
        month_day=body.month_day,
        agent_batch=body.agent_batch,
        policy_ids=body.policy_ids,
    )
    await db.commit()
    return schedule_view(row)


@router.get("/")
async def kb_policy_list(
    status: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    rows = await list_policies(db, status=status)
    return {"items": [policy_to_dict(row) for row in rows]}


@router.post("/")
async def kb_policy_create(
    body: KnowledgePolicyCreate,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    dup = await get_policy_by_code(db, body.code.strip())
    if dup:
        raise HTTPException(status_code=409, detail="policy_code_exists")
    row = await create_policy(
        db,
        code=body.code,
        name=body.name,
        description=body.description,
        config=body.config,
        actor=effective_uid,
        change_note=body.change_note,
    )
    await db.commit()
    await db.refresh(row)
    return policy_to_dict(row)


@router.get("/{policy_id}")
async def kb_policy_get(
    policy_id: str,
    db: AsyncSession = Depends(get_db),
):
    row = await get_policy(db, policy_id)
    if not row:
        raise HTTPException(status_code=404, detail="policy_not_found")
    return policy_to_dict(row)


@router.put("/{policy_id}")
async def kb_policy_update(
    policy_id: str,
    body: KnowledgePolicyUpdate,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    row = await get_policy(db, policy_id)
    if not row:
        raise HTTPException(status_code=404, detail="policy_not_found")
    row = await update_policy(
        db,
        row,
        name=body.name,
        description=body.description,
        config=body.config,
        actor=effective_uid,
        change_note=body.change_note,
    )
    await db.commit()
    await db.refresh(row)
    return policy_to_dict(row)


@router.get("/{policy_id}/versions")
async def kb_policy_versions(
    policy_id: str,
    db: AsyncSession = Depends(get_db),
):
    row = await get_policy(db, policy_id)
    if not row:
        raise HTTPException(status_code=404, detail="policy_not_found")
    versions = await list_policy_versions(db, policy_id)
    return {
        "items": [
            {
                "id": item.id,
                "policy_id": item.policy_id,
                "version": item.version,
                "status": item.status,
                "change_note": item.change_note,
                "created_by": item.created_by,
                "created_at": item.created_at,
            }
            for item in versions
        ]
    }


async def _transition(
    *,
    db: AsyncSession,
    policy_id: str,
    target_status: str,
    effective_uid: str,
    change_note: str,
):
    row = await get_policy(db, policy_id)
    if not row:
        raise HTTPException(status_code=404, detail="policy_not_found")
    try:
        row = await transition_policy_status(
            db,
            row,
            target_status=target_status,
            actor=effective_uid,
            change_note=change_note,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    await db.commit()
    await db.refresh(row)
    return policy_to_dict(row)


@router.post("/{policy_id}/submit")
async def kb_policy_submit(
    policy_id: str,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    return await _transition(
        db=db,
        policy_id=policy_id,
        target_status="pending_approval",
        effective_uid=effective_uid,
        change_note="submit_for_approval",
    )


@router.post("/{policy_id}/approve")
async def kb_policy_approve(
    policy_id: str,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    return await _transition(
        db=db,
        policy_id=policy_id,
        target_status="approved",
        effective_uid=effective_uid,
        change_note="approved",
    )


@router.post("/{policy_id}/auto-govern")
async def kb_policy_auto_govern(policy_id: str, body: AutoGovernBody):
    from backend.services.kb_auto_govern import run_auto_govern

    result = await run_auto_govern(
        policy_id,
        dry_run=body.dry_run,
        consult_agent=body.consult_agent,
    )
    if not result.get("ok"):
        message = str(result.get("message") or "auto_govern_failed")
        status = 404 if message == "policy_not_found" else 400
        raise HTTPException(status_code=status, detail=message)
    return result


@router.post("/{policy_id}/publish")
async def kb_policy_publish(
    policy_id: str,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    return await _transition(
        db=db,
        policy_id=policy_id,
        target_status="published",
        effective_uid=effective_uid,
        change_note="published",
    )


@router.post("/{policy_id}/offline")
async def kb_policy_offline(
    policy_id: str,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    return await _transition(
        db=db,
        policy_id=policy_id,
        target_status="offline",
        effective_uid=effective_uid,
        change_note="offlined",
    )
