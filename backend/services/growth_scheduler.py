"""
成长性后台调度：24h 反馈追问队列、每周学习报告。
"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime

from backend.db import async_session_maker
from backend.services.feedback_service import enqueue_feedback_prompts
from backend.services.learning_service import (
    analyze_feedbacks,
    export_learning_hints,
    generate_weekly_report,
)

logger = logging.getLogger("tpdx.hermes.growth_scheduler")

_TICK_SECONDS = int(os.getenv("GROWTH_SCHEDULER_INTERVAL_SECONDS", "300"))
_ENABLED = os.getenv("GROWTH_SCHEDULER_ENABLED", "true").lower() in ("1", "true", "yes")


class GrowthScheduler:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._last_weekly_key: str | None = None

    async def start(self) -> None:
        if not _ENABLED:
            logger.info("growth_scheduler disabled")
            return
        if self._task and not self._task.done():
            return
        self._task = asyncio.create_task(self._loop(), name="growth-scheduler")
        logger.info("growth_scheduler started interval=%ss", _TICK_SECONDS)

    async def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("growth_scheduler stopped")

    async def _loop(self) -> None:
        while True:
            try:
                await self._tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("growth_scheduler tick failed")
            await asyncio.sleep(_TICK_SECONDS)

    async def _tick(self) -> None:
        async with async_session_maker() as db:
            await enqueue_feedback_prompts(db, hours=24)
            await analyze_feedbacks(db, days=14)
            await export_learning_hints(db)

            now = datetime.now()
            week_key = now.strftime("%Y-W%W")
            if now.weekday() == 0 and now.hour >= 8 and self._last_weekly_key != week_key:
                await generate_weekly_report(db)
                self._last_weekly_key = week_key
                logger.info("growth_scheduler weekly report generated week=%s", week_key)

growth_scheduler = GrowthScheduler()
