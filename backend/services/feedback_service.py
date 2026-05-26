"""
反馈事件服务：结构化采集、memory 行格式化、统计。
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timedelta
from typing import Any, Optional

from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.feedback_event import FeedbackEvent
from backend.models.feedback_prompt import FeedbackPrompt
from backend.models.orchestration_run import OrchestrationRun

logger = logging.getLogger("tpdx.hermes.feedback")

ADOPTION_LEVELS = frozenset({"full", "partial", "reject", "unknown"})
REACTION_TYPES = frozenset({"thumbs_up", "thumbs_down", "adopt", "rewrite"})

REACTION_TO_ADOPTION: dict[str, str] = {
    "thumbs_up": "full",
    "thumbs_down": "reject",
    "adopt": "full",
    "rewrite": "reject",
}


def format_memory_line(
    *,
    session_id: str,
    scenario_id: str | None,
    adoption_level: str,
    reason_text: str | None,
    run_id: str | None = None,
) -> str:
    """统一 feedback memory 行格式。"""
    date = datetime.now().strftime("%Y-%m-%d")
    scene = (scenario_id or "general").strip()
    reason = (reason_text or "").strip() or "-"
    rid = f" run={run_id}" if run_id else ""
    return f"[feedback] {date} {session_id} {scene} {adoption_level}{rid} {reason}"


def resolve_adoption_level(reaction_type: str, explicit: str | None) -> str:
    if explicit and explicit in ADOPTION_LEVELS:
        return explicit
    return REACTION_TO_ADOPTION.get(reaction_type, "unknown")


async def create_feedback(
    db: AsyncSession,
    *,
    user_id: str,
    session_id: str | None,
    message_id: str | None,
    run_id: str | None,
    output_id: str | None,
    project_id: str | None,
    scenario_id: str | None,
    adoption_level: str | None,
    reaction_type: str,
    reason_text: str | None,
    source_excerpt: str | None,
    channel: str = "web",
) -> FeedbackEvent:
    level = resolve_adoption_level(reaction_type, adoption_level)
    memory_line = format_memory_line(
        session_id=session_id or "unknown",
        scenario_id=scenario_id,
        adoption_level=level,
        reason_text=reason_text,
        run_id=run_id,
    )
    row = FeedbackEvent(
        id=str(uuid.uuid4()),
        user_id=user_id,
        channel=channel,
        session_id=session_id,
        message_id=message_id,
        run_id=run_id,
        output_id=output_id,
        project_id=project_id,
        scenario_id=scenario_id,
        adoption_level=level,
        reaction_type=reaction_type,
        reason_text=reason_text,
        source_excerpt=(source_excerpt or "")[:2000] if source_excerpt else None,
        memory_line=memory_line,
    )
    db.add(row)

    if output_id:
        from backend.models.output_asset import OutputAsset

        out = await db.get(OutputAsset, output_id)
        if out:
            out.adoption_level = level
            out.last_feedback_id = row.id

    if run_id:
        prompt = (
            await db.execute(
                select(FeedbackPrompt).where(
                    FeedbackPrompt.run_id == run_id,
                    FeedbackPrompt.prompt_status == "pending",
                )
            )
        ).scalar_one_or_none()
        if prompt:
            prompt.prompt_status = "answered"
            prompt.answered_at = datetime.now().isoformat()
            prompt.feedback_id = row.id

    await db.commit()
    await db.refresh(row)
    logger.info(
        "feedback created id=%s run_id=%s level=%s reaction=%s user=%s",
        row.id,
        run_id,
        level,
        reaction_type,
        user_id,
    )
    return row


async def get_feedback_for_message(
    db: AsyncSession,
    *,
    session_id: str,
    message_id: str,
) -> FeedbackEvent | None:
    result = await db.execute(
        select(FeedbackEvent)
        .where(
            FeedbackEvent.session_id == session_id,
            FeedbackEvent.message_id == message_id,
        )
        .order_by(desc(FeedbackEvent.created_at))
        .limit(1)
    )
    return result.scalar_one_or_none()


async def list_feedback(
    db: AsyncSession,
    *,
    run_id: str | None = None,
    session_id: str | None = None,
    project_id: str | None = None,
    limit: int = 50,
) -> list[FeedbackEvent]:
    q = select(FeedbackEvent).order_by(desc(FeedbackEvent.created_at)).limit(min(limit, 200))
    if run_id:
        q = q.where(FeedbackEvent.run_id == run_id)
    if session_id:
        q = q.where(FeedbackEvent.session_id == session_id)
    if project_id:
        q = q.where(FeedbackEvent.project_id == project_id)
    result = await db.execute(q)
    return list(result.scalars().all())


async def feedback_stats(db: AsyncSession, *, days: int = 7) -> dict[str, Any]:
    since = (datetime.now() - timedelta(days=max(1, min(days, 90)))).isoformat()
    rows = (
        await db.execute(
            select(FeedbackEvent.adoption_level, func.count(FeedbackEvent.id))
            .where(FeedbackEvent.created_at >= since)
            .group_by(FeedbackEvent.adoption_level)
        )
    ).all()
    by_level = {str(r[0]): int(r[1]) for r in rows}
    total = sum(by_level.values())
    full = by_level.get("full", 0)
    partial = by_level.get("partial", 0)
    reject = by_level.get("reject", 0)
    adoption_rate = round((full + partial * 0.5) / total, 4) if total else 0.0
    rewrite_count = (
        await db.execute(
            select(func.count(FeedbackEvent.id)).where(
                FeedbackEvent.created_at >= since,
                FeedbackEvent.reaction_type == "rewrite",
            )
        )
    ).scalar() or 0
    return {
        "days": days,
        "total": total,
        "by_level": by_level,
        "adoption_rate": adoption_rate,
        "rewrite_rate": round(rewrite_count / total, 4) if total else 0.0,
        "rewrite_count": int(rewrite_count),
    }


async def enqueue_feedback_prompts(db: AsyncSession, *, hours: int = 24) -> int:
    """为已完成且无反馈的 run 创建追问队列项。"""
    cutoff = (datetime.now() - timedelta(hours=hours)).isoformat()
    runs = (
        await db.execute(
            select(OrchestrationRun)
            .where(
                OrchestrationRun.status == "completed",
                OrchestrationRun.created_at <= cutoff,
            )
            .order_by(desc(OrchestrationRun.created_at))
            .limit(100)
        )
    ).scalars().all()

    created = 0
    for run in runs:
        existing_fb = (
            await db.execute(
                select(FeedbackEvent.id).where(FeedbackEvent.run_id == run.id).limit(1)
            )
        ).scalar_one_or_none()
        if existing_fb:
            continue
        existing_prompt = (
            await db.execute(
                select(FeedbackPrompt.id).where(FeedbackPrompt.run_id == run.id).limit(1)
            )
        ).scalar_one_or_none()
        if existing_prompt:
            continue
        db.add(
            FeedbackPrompt(
                id=str(uuid.uuid4()),
                run_id=run.id,
                project_id=run.project_id,
                user_id="default",
                prompt_status="pending",
            )
        )
        created += 1
    if created:
        await db.commit()
        logger.info("feedback_prompts enqueued count=%s", created)
    return created


async def list_pending_prompts(
    db: AsyncSession,
    *,
    session_id: str | None = None,
    limit: int = 20,
) -> list[FeedbackPrompt]:
    q = (
        select(FeedbackPrompt)
        .where(FeedbackPrompt.prompt_status == "pending")
        .order_by(desc(FeedbackPrompt.created_at))
        .limit(min(limit, 50))
    )
    if session_id:
        q = q.where(FeedbackPrompt.session_id == session_id)
    result = await db.execute(q)
    return list(result.scalars().all())


def feedback_event_to_dict(row: FeedbackEvent) -> dict[str, Any]:
    return {
        "id": row.id,
        "user_id": row.user_id,
        "channel": row.channel,
        "session_id": row.session_id,
        "message_id": row.message_id,
        "run_id": row.run_id,
        "output_id": row.output_id,
        "project_id": row.project_id,
        "scenario_id": row.scenario_id,
        "adoption_level": row.adoption_level,
        "reaction_type": row.reaction_type,
        "reason_text": row.reason_text,
        "memory_line": row.memory_line,
        "created_at": row.created_at,
    }
