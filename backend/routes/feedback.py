from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import get_db
from backend.services.experience_service import (
    experience_entry_to_dict,
    save_experience_from_feedback,
)
from backend.services.kb_contract import TPD_EXPERIENCE_COLLECTION
from backend.services.feedback_service import (
    REACTION_TYPES,
    create_feedback,
    feedback_event_to_dict,
    feedback_stats,
    get_feedback_for_message,
    list_feedback,
    list_pending_prompts,
)
from backend.services.learning_service import (
    analyze_feedbacks,
    export_learning_hints,
    generate_weekly_report,
    get_latest_report,
    kb_miss_rate,
    list_open_signals,
    signal_to_dict,
    update_signal_status,
)
from backend.services.user_identity import get_effective_user_id

router = APIRouter(prefix="/feedback", tags=["feedback"])
logger = logging.getLogger("tpdx.hermes.feedback")


class FeedbackSubmitIn(BaseModel):
    session_id: str | None = None
    message_id: str | None = None
    run_id: str | None = None
    output_id: str | None = None
    project_id: str | None = None
    scenario_id: str | None = None
    adoption_level: str | None = Field(default=None, description="full|partial|reject|unknown")
    reaction_type: str = Field(description="thumbs_up|thumbs_down|adopt|rewrite")
    reason_text: str | None = None
    source_excerpt: str | None = None
    save_experience: bool = False
    experience_title: str | None = None


@router.post("")
async def submit_feedback(
    body: FeedbackSubmitIn,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    if body.reaction_type not in REACTION_TYPES:
        raise HTTPException(400, f"reaction_type 无效，允许: {sorted(REACTION_TYPES)}")

    row = await create_feedback(
        db,
        user_id=effective_uid,
        session_id=body.session_id,
        message_id=body.message_id,
        run_id=body.run_id,
        output_id=body.output_id,
        project_id=body.project_id,
        scenario_id=body.scenario_id,
        adoption_level=body.adoption_level,
        reaction_type=body.reaction_type,
        reason_text=body.reason_text,
        source_excerpt=body.source_excerpt,
    )

    experience = None
    if body.save_experience and body.source_excerpt and row.adoption_level in ("full", "partial"):
        title = (body.experience_title or "对话经验").strip()
        exp = await save_experience_from_feedback(
            db,
            feedback=row,
            content=body.source_excerpt,
            title=title,
        )
        experience = experience_entry_to_dict(exp)

    logger.info(
        "feedback submit id=%s reaction=%s run_id=%s message_id=%s",
        row.id,
        body.reaction_type,
        body.run_id,
        body.message_id,
    )
    return {
        "ok": True,
        "feedback": feedback_event_to_dict(row),
        "experience": experience,
    }


@router.get("")
async def query_feedback(
    run_id: str | None = None,
    session_id: str | None = None,
    project_id: str | None = None,
    message_id: str | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    if session_id and message_id:
        one = await get_feedback_for_message(db, session_id=session_id, message_id=message_id)
        if one:
            if (one.user_id or "").strip() and (one.user_id or "").strip() != effective_uid:
                return {"items": []}
            return {"items": [feedback_event_to_dict(one)]}
        return {"items": []}
    rows = await list_feedback(
        db,
        run_id=run_id,
        session_id=session_id,
        project_id=project_id,
        user_id=effective_uid,
        limit=limit,
    )
    return {"items": [feedback_event_to_dict(r) for r in rows]}


@router.get("/stats")
async def get_feedback_stats(
    days: int = Query(default=7, ge=1, le=90),
    db: AsyncSession = Depends(get_db),
):
    stats = await feedback_stats(db, days=days)
    signals = await list_open_signals(db, limit=20)
    latest_report = await get_latest_report(db)
    report_summary = None
    if latest_report and latest_report.summary_json:
        import json

        try:
            report_summary = json.loads(latest_report.summary_json)
        except json.JSONDecodeError:
            report_summary = None

    learning_conversion_rate = 0.0
    if stats["total"] > 0:
        learning_conversion_rate = round(len(signals) / stats["total"], 4)

    miss_rate = await kb_miss_rate(db, days=days)

    return {
        **stats,
        "learning_conversion_rate": learning_conversion_rate,
        "open_signals": [signal_to_dict(s) for s in signals],
        "latest_weekly_report": report_summary,
        "kb_miss_rate": miss_rate,
    }


@router.get("/pending-prompts")
async def get_pending_feedback_prompts(
    session_id: str | None = None,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    rows = await list_pending_prompts(db, session_id=session_id, user_id=effective_uid)
    return {
        "items": [
            {
                "id": r.id,
                "run_id": r.run_id,
                "output_id": r.output_id,
                "session_id": r.session_id,
                "message_id": r.message_id,
                "project_id": r.project_id,
                "prompt_status": r.prompt_status,
                "created_at": r.created_at,
            }
            for r in rows
        ]
    }


learning_router = APIRouter(prefix="/learning", tags=["learning"])


@learning_router.post("/analyze")
async def run_learning_analysis(
    days: int = Query(default=14, ge=1, le=60),
    db: AsyncSession = Depends(get_db),
):
    signals = await analyze_feedbacks(db, days=days)
    return {"signals": [signal_to_dict(s) for s in signals], "count": len(signals)}


@learning_router.get("/signals")
async def get_learning_signals(
    limit: int = Query(default=50, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
):
    rows = await list_open_signals(db, limit=limit)
    return {"items": [signal_to_dict(r) for r in rows]}


class LearningSignalStatusIn(BaseModel):
    status: str = Field(description="ack|dismissed")


@learning_router.patch("/signals/{signal_id}")
async def resolve_learning_signal(
    signal_id: str,
    body: LearningSignalStatusIn,
    db: AsyncSession = Depends(get_db),
):
    status = (body.status or "").strip().lower()
    if status not in ("ack", "dismissed"):
        raise HTTPException(400, "status 无效，允许: ack, dismissed")
    try:
        row = await update_signal_status(db, signal_id, status=status)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    if not row:
        raise HTTPException(404, "学习信号不存在")
    await export_learning_hints(db)
    logger.info("learning signal resolved via api id=%s status=%s", signal_id, status)
    return {"ok": True, "signal": signal_to_dict(row)}


@learning_router.post("/reports/weekly")
async def create_weekly_report(db: AsyncSession = Depends(get_db)):
    report = await generate_weekly_report(db)
    import json

    summary: dict[str, Any] = {}
    try:
        summary = json.loads(report.summary_json)
    except json.JSONDecodeError:
        pass
    return {"id": report.id, "week_start": report.week_start, "summary": summary}


@learning_router.get("/experience")
async def list_experience_index(
    limit: int = Query(default=50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
):
    from backend.services.experience_service import experience_entry_to_dict, list_experience_entries

    rows = await list_experience_entries(db, limit=limit)
    return {"items": [experience_entry_to_dict(r) for r in rows], "collection": TPD_EXPERIENCE_COLLECTION}


@learning_router.get("/reports/latest")
async def latest_weekly_report(db: AsyncSession = Depends(get_db)):
    report = await get_latest_report(db)
    if not report:
        return {"report": None}
    import json

    summary: dict[str, Any] = {}
    try:
        summary = json.loads(report.summary_json)
    except json.JSONDecodeError:
        pass
    return {
        "report": {
            "id": report.id,
            "week_start": report.week_start,
            "summary": summary,
            "created_at": report.created_at,
        }
    }
