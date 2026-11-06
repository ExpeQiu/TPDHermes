"""项目活跃度：把产出、附件、执行、文件操作与埋点归到上海日历日。"""

from __future__ import annotations

import logging
from datetime import datetime
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.orchestration_run import OrchestrationRun
from backend.models.output_asset import OutputAsset
from backend.models.project_attachment import ProjectAttachment
from backend.models.project_file_domain import ProjectFileActionLog
from backend.models.usage_event import UsageEvent

logger = logging.getLogger("tpdx.hermes")

SHANGHAI = ZoneInfo("Asia/Shanghai")
_MIN_YEAR = 2000


class ProjectActivityDay(BaseModel):
    date: str
    count: int


class ProjectActivityResponse(BaseModel):
    days: list[ProjectActivityDay] = Field(default_factory=list)
    total: int = 0


def activity_day(raw: str | None, *, now: datetime | None = None) -> str | None:
    """把时间戳归到 Asia/Shanghai 的日历日。无时区按上海本地时间理解。"""
    if raw is None:
        return None
    text = raw.strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        if len(text) >= 10 and text[4] == "-" and text[7] == "-":
            day = text[:10]
        else:
            return None
    else:
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=SHANGHAI)
        day = parsed.astimezone(SHANGHAI).date().isoformat()
    try:
        year = int(day[:4])
    except ValueError:
        return None
    ceiling = (now or datetime.now(SHANGHAI)).year + 1
    if year < _MIN_YEAR or year > ceiling:
        return None
    return day


def bucket_activity_days(stamps: list[str | None], *, now: datetime | None = None) -> list[ProjectActivityDay]:
    counts: dict[str, int] = {}
    for stamp in stamps:
        day = activity_day(stamp, now=now)
        if day is None:
            continue
        counts[day] = counts.get(day, 0) + 1
    return [ProjectActivityDay(date=day, count=counts[day]) for day in sorted(counts)]


async def load_project_activity(db: AsyncSession, project_id: str) -> ProjectActivityResponse:
    stamps: list[str | None] = []
    sources = (
        select(OutputAsset.created_at).where(OutputAsset.project_id == project_id),
        select(ProjectAttachment.created_at).where(ProjectAttachment.project_id == project_id),
        select(OrchestrationRun.created_at).where(OrchestrationRun.project_id == project_id),
        select(ProjectFileActionLog.created_at).where(ProjectFileActionLog.project_id == project_id),
        select(UsageEvent.event_time).where(UsageEvent.project_id == project_id),
    )
    for stmt in sources:
        rows = (await db.execute(stmt)).scalars().all()
        stamps.extend(rows)
    days = bucket_activity_days(stamps)
    total = sum(day.count for day in days)
    logger.info(
        "project activity loaded project_id=%s total=%s active_days=%s",
        project_id,
        total,
        len(days),
    )
    return ProjectActivityResponse(days=days, total=total)
