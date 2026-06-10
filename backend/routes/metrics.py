from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import get_db
from backend.models.usage_event import UsageEvent
from backend.services.chat_wordcloud_service import build_chat_wordcloud
from backend.services.conversation_metrics_service import build_conversation_metrics
from backend.services.skill_metrics_service import build_skill_metrics
from backend.services.rbac import require_feature
from backend.services.user_identity import get_effective_user_id

router = APIRouter(prefix="/metrics", tags=["metrics"])
logger = logging.getLogger("tpdx.hermes.metrics")


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _since_iso(days: int) -> str:
    return (
        datetime.now(timezone.utc) - timedelta(days=days)
    ).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class UsageEventIn(BaseModel):
    event_name: str = Field(min_length=1, max_length=120)
    feature: str | None = Field(default=None, max_length=120)
    action: str | None = Field(default=None, max_length=120)
    user_id: str | None = Field(default=None, max_length=200)
    session_id: str | None = Field(default=None, max_length=200)
    page_path: str | None = Field(default=None, max_length=300)
    project_id: str | None = Field(default=None, max_length=120)
    event_time: str | None = None
    properties: dict | None = None


class UsageEventBatchIn(BaseModel):
    events: list[UsageEventIn] = Field(default_factory=list, max_length=200)


class FeatureUsageRow(BaseModel):
    feature: str
    event_count: int
    user_count: int
    session_count: int


class UserUsageRow(BaseModel):
    user_id: str
    event_count: int
    feature_count: int


class FeatureUserFrequencyRow(BaseModel):
    feature: str
    user_id: str
    event_count: int


class DailyUsageRow(BaseModel):
    date: str
    event_count: int
    user_count: int


class SkillUsageRow(BaseModel):
    skill_name: str
    call_count: int
    user_count: int
    feedback_count: int
    adoption_rate: float | None = None
    full_count: int = 0
    partial_count: int = 0
    reject_count: int = 0


class DailyConversationRow(BaseModel):
    date: str
    session_count: int
    avg_rounds: float


class ChatWordTermRow(BaseModel):
    text: str
    count: int
    weight: float = 0.0
    sample: str = ""


class UsageOverviewResponse(BaseModel):
    days: int
    total_events: int
    total_users: int
    skills_total_calls: int = 0
    skills_feedback_count: int = 0
    skills_overall_adoption_rate: float | None = None
    chat_run_count: int = 0
    chat_session_count: int = 0
    avg_conversation_rounds: float | None = None
    max_conversation_rounds: int = 0
    new_conversation_count: int = 0
    chat_wordcloud_mode: str = "fallback"
    feature_usage: list[FeatureUsageRow]
    user_usage: list[UserUsageRow]
    feature_user_frequency: list[FeatureUserFrequencyRow]
    daily_usage: list[DailyUsageRow]
    skill_usage: list[SkillUsageRow] = Field(default_factory=list)
    daily_conversation: list[DailyConversationRow] = Field(default_factory=list)
    chat_wordcloud_terms: list[ChatWordTermRow] = Field(default_factory=list)


@router.post("/events")
async def ingest_usage_events(
    body: UsageEventBatchIn,
    request: Request,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    if not body.events:
        return {"accepted": 0}
    now = _utc_now_iso()
    rows: list[UsageEvent] = []
    for item in body.events:
        uid = (item.user_id or "").strip() or effective_uid
        rows.append(
            UsageEvent(
                id=str(uuid.uuid4()),
                event_name=item.event_name.strip(),
                feature=(item.feature or "").strip() or None,
                action=(item.action or "").strip() or None,
                user_id=uid,
                session_id=(item.session_id or "").strip() or None,
                page_path=(item.page_path or "").strip() or request.url.path,
                project_id=(item.project_id or "").strip() or None,
                event_time=(item.event_time or "").strip() or now,
                properties_json=json.dumps(item.properties, ensure_ascii=False)
                if item.properties
                else None,
                created_at=now,
            )
        )
    db.add_all(rows)
    await db.commit()
    logger.info("metrics ingest accepted=%s", len(rows))
    return {"accepted": len(rows)}


@router.get("/feature-usage", response_model=UsageOverviewResponse)
async def get_feature_usage_overview(
    days: int = 7,
    top: int = 20,
    db: AsyncSession = Depends(get_db),
    _ops: str = Depends(require_feature("ops")),
):
    q_days = min(max(days, 1), 60)
    q_top = min(max(top, 5), 100)
    since = _since_iso(q_days)

    total_row = (
        await db.execute(
            select(
                func.count(UsageEvent.id),
                func.count(func.distinct(UsageEvent.user_id)),
            ).where(UsageEvent.event_time >= since)
        )
    ).one()
    total_events = int(total_row[0] or 0)
    total_users = int(total_row[1] or 0)

    feature_rows = (
        await db.execute(
            select(
                UsageEvent.feature,
                func.count(UsageEvent.id).label("event_count"),
                func.count(func.distinct(UsageEvent.user_id)).label("user_count"),
                func.count(func.distinct(UsageEvent.session_id)).label("session_count"),
            )
            .where(UsageEvent.event_time >= since, UsageEvent.feature.is_not(None))
            .group_by(UsageEvent.feature)
            .order_by(desc("event_count"))
            .limit(q_top)
        )
    ).all()

    user_rows = (
        await db.execute(
            select(
                UsageEvent.user_id,
                func.count(UsageEvent.id).label("event_count"),
                func.count(func.distinct(UsageEvent.feature)).label("feature_count"),
            )
            .where(UsageEvent.event_time >= since)
            .group_by(UsageEvent.user_id)
            .order_by(desc("event_count"))
            .limit(q_top)
        )
    ).all()

    feature_user_rows = (
        await db.execute(
            select(
                UsageEvent.feature,
                UsageEvent.user_id,
                func.count(UsageEvent.id).label("event_count"),
            )
            .where(UsageEvent.event_time >= since, UsageEvent.feature.is_not(None))
            .group_by(UsageEvent.feature, UsageEvent.user_id)
            .order_by(desc("event_count"))
            .limit(q_top * 2)
        )
    ).all()

    daily_rows = (
        await db.execute(
            select(
                func.substr(UsageEvent.event_time, 1, 10).label("day"),
                func.count(UsageEvent.id).label("event_count"),
                func.count(func.distinct(UsageEvent.user_id)).label("user_count"),
            )
            .where(UsageEvent.event_time >= since)
            .group_by("day")
            .order_by("day")
        )
    ).all()

    skill_metrics = await build_skill_metrics(db, since=since, top=q_top)
    conversation_metrics = await build_conversation_metrics(db, since=since)
    wordcloud_metrics = await build_chat_wordcloud(db, since=since, top=30)

    return UsageOverviewResponse(
        days=q_days,
        total_events=total_events,
        total_users=total_users,
        skills_total_calls=int(skill_metrics.get("skills_total_calls") or 0),
        skills_feedback_count=int(skill_metrics.get("skills_feedback_count") or 0),
        skills_overall_adoption_rate=skill_metrics.get("skills_overall_adoption_rate"),
        chat_run_count=int(conversation_metrics.get("chat_run_count") or 0),
        chat_session_count=int(conversation_metrics.get("chat_session_count") or 0),
        avg_conversation_rounds=conversation_metrics.get("avg_conversation_rounds"),
        max_conversation_rounds=int(conversation_metrics.get("max_conversation_rounds") or 0),
        new_conversation_count=int(wordcloud_metrics.get("new_conversation_count") or 0),
        chat_wordcloud_mode=str(wordcloud_metrics.get("segmentation_mode") or "fallback"),
        feature_usage=[
            FeatureUsageRow(
                feature=str(row[0] or "unknown"),
                event_count=int(row[1] or 0),
                user_count=int(row[2] or 0),
                session_count=int(row[3] or 0),
            )
            for row in feature_rows
        ],
        user_usage=[
            UserUsageRow(
                user_id=str(row[0] or "unknown"),
                event_count=int(row[1] or 0),
                feature_count=int(row[2] or 0),
            )
            for row in user_rows
        ],
        feature_user_frequency=[
            FeatureUserFrequencyRow(
                feature=str(row[0] or "unknown"),
                user_id=str(row[1] or "unknown"),
                event_count=int(row[2] or 0),
            )
            for row in feature_user_rows
        ],
        daily_usage=[
            DailyUsageRow(
                date=str(row[0] or ""),
                event_count=int(row[1] or 0),
                user_count=int(row[2] or 0),
            )
            for row in daily_rows
        ],
        skill_usage=[
            SkillUsageRow(
                skill_name=str(row.get("skill_name") or "unknown"),
                call_count=int(row.get("call_count") or 0),
                user_count=int(row.get("user_count") or 0),
                feedback_count=int(row.get("feedback_count") or 0),
                adoption_rate=row.get("adoption_rate"),
                full_count=int(row.get("full_count") or 0),
                partial_count=int(row.get("partial_count") or 0),
                reject_count=int(row.get("reject_count") or 0),
            )
            for row in skill_metrics.get("skill_usage") or []
        ],
        daily_conversation=[
            DailyConversationRow(
                date=str(row.get("date") or ""),
                session_count=int(row.get("session_count") or 0),
                avg_rounds=float(row.get("avg_rounds") or 0),
            )
            for row in conversation_metrics.get("daily_conversation") or []
        ],
        chat_wordcloud_terms=[
            ChatWordTermRow(
                text=str(row.get("text") or ""),
                count=int(row.get("count") or 0),
                weight=float(row.get("weight") or 0),
                sample=str(row.get("sample") or ""),
            )
            for row in wordcloud_metrics.get("terms") or []
        ],
    )
