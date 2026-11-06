"""定时治理配置：缺行时用环境变量补一次，之后只认页面保存的值。"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import async_session_maker
from backend.models.kb_govern_schedule import SCHEDULE_ROW_ID, KbGovernSchedule

logger = logging.getLogger("tpdx.hermes.kb_govern_settings")

MIN_BATCH = 1
MAX_BATCH = 50
CADENCES = {"daily", "weekly", "monthly"}
_TIME = re.compile(r"^(\d{1,2}):(\d{1,2})$")


def _flag(raw: str | None, default: bool = False) -> bool:
    text = (raw if raw is not None else "").strip().lower()
    if not text:
        return default
    return text in {"1", "true", "yes", "on"}


def normalize_run_time(raw: str | None) -> str:
    match = _TIME.match((raw or "").strip())
    if not match:
        return "02:00"
    hour = min(23, max(0, int(match.group(1))))
    minute = min(59, max(0, int(match.group(2))))
    return f"{hour:02d}:{minute:02d}"


def normalize_policy_ids(raw: list[str] | None) -> list[str]:
    seen: list[str] = []
    for item in raw or []:
        text = str(item).strip()
        if text and text not in seen:
            seen.append(text)
    return seen


def normalize_schedule(
    *,
    enabled: bool,
    cadence: str,
    run_time: str,
    weekday: int,
    month_day: int,
    agent_batch: int,
    policy_ids: list[str] | None,
) -> dict:
    kind = cadence if cadence in CADENCES else "daily"
    try:
        week = int(weekday)
    except (TypeError, ValueError):
        week = 0
    try:
        day = int(month_day)
    except (TypeError, ValueError):
        day = 1
    try:
        batch = int(agent_batch)
    except (TypeError, ValueError):
        batch = 20
    return {
        "enabled": bool(enabled),
        "cadence": kind,
        "run_time": normalize_run_time(run_time),
        "weekday": min(6, max(0, week)),
        "month_day": min(28, max(1, day)),
        "agent_batch": min(MAX_BATCH, max(MIN_BATCH, batch)),
        "policy_ids": normalize_policy_ids(policy_ids),
    }


def defaults_from_env() -> dict:
    raw_batch = os.getenv("KB_GOVERN_AGENT_BATCH")
    batch = 20 if raw_batch is None or not str(raw_batch).strip() else raw_batch
    return normalize_schedule(
        enabled=_flag(os.getenv("KB_GOVERN_SCHEDULER_ENABLED"), False),
        cadence="daily",
        run_time="02:00",
        weekday=0,
        month_day=1,
        agent_batch=batch,
        policy_ids=[],
    )


def _policy_ids(row: KbGovernSchedule) -> list[str]:
    try:
        data = json.loads(row.policy_ids_json or "[]")
    except json.JSONDecodeError:
        return []
    return normalize_policy_ids(data if isinstance(data, list) else [])


def schedule_view(row: KbGovernSchedule) -> dict:
    return {
        "enabled": bool(row.enabled),
        "cadence": row.cadence or "daily",
        "run_time": normalize_run_time(row.run_time),
        "weekday": int(row.weekday or 0),
        "month_day": int(row.month_day or 1),
        "agent_batch": int(row.agent_batch or 20),
        "policy_ids": _policy_ids(row),
        "last_run_at": row.last_run_at,
        "updated_at": row.updated_at,
    }


def scheduled_slot(
    now: datetime,
    *,
    cadence: str,
    run_time: str,
    weekday: int,
    month_day: int,
) -> datetime | None:
    """当前时刻已经到达本周期触发点时，返回该触发点；否则返回空。"""
    hour_text, minute_text = normalize_run_time(run_time).split(":")
    slot = now.replace(hour=int(hour_text), minute=int(minute_text), second=0, microsecond=0)
    if cadence == "weekly" and now.weekday() != int(weekday):
        return None
    if cadence == "monthly" and now.day != int(month_day):
        return None
    if now < slot:
        return None
    return slot


def schedule_is_due(settings: dict, now: datetime) -> bool:
    if not settings.get("enabled"):
        return False
    slot = scheduled_slot(
        now,
        cadence=str(settings.get("cadence") or "daily"),
        run_time=str(settings.get("run_time") or "02:00"),
        weekday=int(settings.get("weekday") or 0),
        month_day=int(settings.get("month_day") or 1),
    )
    if slot is None:
        return False
    last_raw = str(settings.get("last_run_at") or "").strip()
    if not last_raw:
        return True
    try:
        last = datetime.fromisoformat(last_raw)
    except ValueError:
        return True
    return last < slot


async def get_or_create_schedule(db: AsyncSession) -> KbGovernSchedule:
    row = await db.get(KbGovernSchedule, SCHEDULE_ROW_ID)
    if row is not None:
        return row
    seeded = defaults_from_env()
    row = KbGovernSchedule(
        id=SCHEDULE_ROW_ID,
        enabled=seeded["enabled"],
        agent_batch=seeded["agent_batch"],
        cadence=seeded["cadence"],
        run_time=seeded["run_time"],
        weekday=seeded["weekday"],
        month_day=seeded["month_day"],
        policy_ids_json="[]",
        updated_at=datetime.now().isoformat(),
    )
    db.add(row)
    await db.flush()
    logger.info(
        "kb_govern_schedule seeded enabled=%s cadence=%s run_time=%s agent_batch=%s source=env",
        seeded["enabled"],
        seeded["cadence"],
        seeded["run_time"],
        seeded["agent_batch"],
    )
    return row


async def save_schedule(
    db: AsyncSession,
    *,
    enabled: bool,
    cadence: str,
    run_time: str,
    weekday: int,
    month_day: int,
    agent_batch: int,
    policy_ids: list[str] | None,
) -> KbGovernSchedule:
    cleaned = normalize_schedule(
        enabled=enabled,
        cadence=cadence,
        run_time=run_time,
        weekday=weekday,
        month_day=month_day,
        agent_batch=agent_batch,
        policy_ids=policy_ids,
    )
    row = await get_or_create_schedule(db)
    row.enabled = cleaned["enabled"]
    row.cadence = cleaned["cadence"]
    row.run_time = cleaned["run_time"]
    row.weekday = cleaned["weekday"]
    row.month_day = cleaned["month_day"]
    row.agent_batch = cleaned["agent_batch"]
    row.policy_ids_json = json.dumps(cleaned["policy_ids"], ensure_ascii=False)
    row.updated_at = datetime.now().isoformat()
    logger.info(
        "kb_govern_schedule saved enabled=%s cadence=%s run_time=%s weekday=%s month_day=%s agent_batch=%s policies=%s",
        cleaned["enabled"],
        cleaned["cadence"],
        cleaned["run_time"],
        cleaned["weekday"],
        cleaned["month_day"],
        cleaned["agent_batch"],
        len(cleaned["policy_ids"]),
    )
    return row


async def mark_schedule_ran(when: datetime) -> None:
    async with async_session_maker() as db:
        row = await get_or_create_schedule(db)
        row.last_run_at = when.isoformat(timespec="seconds")
        await db.commit()
        logger.info("kb_govern_schedule ran_at=%s", row.last_run_at)


async def load_schedule() -> dict:
    async with async_session_maker() as db:
        row = await get_or_create_schedule(db)
        await db.commit()
        return schedule_view(row)
