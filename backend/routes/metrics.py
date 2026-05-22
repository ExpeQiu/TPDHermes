from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import get_db
from backend.models.usage_event import UsageEvent
from backend.services.user_identity import get_effective_user_id

router = APIRouter(prefix="/metrics", tags=["metrics"])
logger = logging.getLogger("tpdx.hermes.metrics")


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


class UsageOverviewResponse(BaseModel):
    days: int
    total_events: int
    total_users: int
    feature_usage: list[FeatureUsageRow]
    user_usage: list[UserUsageRow]
    feature_user_frequency: list[FeatureUserFrequencyRow]
    daily_usage: list[DailyUsageRow]


@router.post("/events")
async def ingest_usage_events(
    body: UsageEventBatchIn,
    request: Request,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    if not body.events:
        return {"accepted": 0}
    now = datetime.now().isoformat()
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
):
    q_days = min(max(days, 1), 60)
    q_top = min(max(top, 5), 100)
    since = (datetime.now() - timedelta(days=q_days)).isoformat()

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

    return UsageOverviewResponse(
        days=q_days,
        total_events=total_events,
        total_users=total_users,
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
    )
