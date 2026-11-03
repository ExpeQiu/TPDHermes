"""系统是否静默：没有进行中的对话或编排时，才做周期性复盘。"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta

from sqlalchemy import desc, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.chat_session import ChatMessageRecord
from backend.models.orchestration_run import OrchestrationRun
from backend.models.project_room import ProjectRoom, ProjectRoomMessage

logger = logging.getLogger("tpdx.hermes.system_quiet")


def idle_seconds() -> int:
    raw = os.getenv("SKILL_EVOLUTION_IDLE_SECONDS", "600")
    try:
        return max(0, int(raw))
    except ValueError:
        return 600


def _parse_ts(raw: str | None) -> datetime | None:
    text = (raw or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.replace(tzinfo=None)
    return parsed


def _is_recent(raw: str | None, cutoff: datetime) -> bool:
    parsed = _parse_ts(raw)
    return parsed is not None and parsed >= cutoff


async def _latest(db: AsyncSession, stmt) -> str | None:
    try:
        async with db.begin_nested():
            return (await db.execute(stmt)).scalar_one_or_none()
    except SQLAlchemyError:
        logger.info("system_quiet probe skipped")
        return None


async def system_is_quiet(db: AsyncSession, *, idle_seconds_value: int | None = None) -> tuple[bool, str]:
    """返回 (是否静默, 原因)。进行中且最近仍有更新的轮次会挡住复盘。"""
    window = idle_seconds() if idle_seconds_value is None else max(0, idle_seconds_value)
    cutoff = datetime.now() - timedelta(seconds=window)

    chat_at = await _latest(
        db,
        select(ChatMessageRecord.created_at).order_by(desc(ChatMessageRecord.created_at)).limit(1),
    )
    if _is_recent(chat_at, cutoff):
        logger.info("system_quiet quiet=false reason=chat idle_seconds=%s", window)
        return False, "chat"

    room_at = await _latest(
        db,
        select(ProjectRoomMessage.created_at).order_by(desc(ProjectRoomMessage.created_at)).limit(1),
    )
    if _is_recent(room_at, cutoff):
        logger.info("system_quiet quiet=false reason=room_message idle_seconds=%s", window)
        return False, "room_message"

    try:
        async with db.begin_nested():
            running = (
                await db.execute(
                    select(OrchestrationRun.updated_at).where(OrchestrationRun.status == "running")
                )
            ).scalars().all()
    except SQLAlchemyError:
        logger.info("system_quiet run probe skipped")
        running = []
    if any(_is_recent(item, cutoff) for item in running):
        logger.info("system_quiet quiet=false reason=run idle_seconds=%s", window)
        return False, "run"

    try:
        async with db.begin_nested():
            rooms = (
                await db.execute(
                    select(ProjectRoom.updated_at).where(
                        ProjectRoom.active_turn_id.is_not(None),
                        ProjectRoom.active_turn_id != "",
                    )
                )
            ).scalars().all()
    except SQLAlchemyError:
        logger.info("system_quiet room probe skipped")
        rooms = []
    if any(_is_recent(item, cutoff) for item in rooms):
        logger.info("system_quiet quiet=false reason=room_turn idle_seconds=%s", window)
        return False, "room_turn"

    logger.info("system_quiet quiet=true reason=idle idle_seconds=%s", window)
    return True, "idle"
