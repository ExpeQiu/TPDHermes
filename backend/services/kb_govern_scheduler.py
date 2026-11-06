"""定时驱动知识库自动治理：规则归位后，把判不准的文档交给 Hermes。"""

from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime

from backend.db import async_session_maker
from backend.services.kb_auto_govern import run_auto_govern
from backend.services.kb_govern_settings import load_schedule, mark_schedule_ran, schedule_is_due
from backend.services.knowledge_policy_store import list_policies

logger = logging.getLogger("tpdx.hermes.kb_govern_scheduler")

_IDLE_SECONDS = 30


def loop_enabled() -> bool:
    return os.getenv("KB_GOVERN_SCHEDULER_LOOP", "true").strip().lower() not in {"0", "false", "no", "off"}


class KBGovernScheduler:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._seen: tuple | None = None

    async def start(self) -> None:
        if not loop_enabled():
            logger.info("kb_govern_scheduler loop disabled")
            return
        if self._task and not self._task.done():
            return
        self._task = asyncio.create_task(self._loop(), name="kb-govern-scheduler")
        logger.info("kb_govern_scheduler started")

    async def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("kb_govern_scheduler stopped")

    async def _loop(self) -> None:
        while True:
            try:
                settings = await load_schedule()
                signature = (
                    bool(settings["enabled"]),
                    settings["cadence"],
                    settings["run_time"],
                    settings["weekday"],
                    settings["month_day"],
                    settings["agent_batch"],
                    tuple(settings["policy_ids"]),
                )
                if signature != self._seen:
                    logger.info(
                        "kb_govern_scheduler config enabled=%s cadence=%s run_time=%s weekday=%s month_day=%s agent_batch=%s policies=%s",
                        *signature[:6],
                        len(signature[6]),
                    )
                    self._seen = signature
                now = datetime.now()
                if schedule_is_due(settings, now):
                    await self.tick(settings)
                    await mark_schedule_ran(now)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("kb_govern_scheduler tick failed")
            await asyncio.sleep(_IDLE_SECONDS)

    async def tick(self, settings: dict | None = None) -> None:
        selected = set((settings or {}).get("policy_ids") or [])
        async with async_session_maker() as db:
            policies = await list_policies(db, status="published")
            policy_ids = [str(row.id) for row in policies]
        if selected:
            policy_ids = [item for item in policy_ids if item in selected]
        logger.info("kb_govern_scheduler tick policies=%s", len(policy_ids))
        for policy_id in policy_ids:
            result = await run_auto_govern(policy_id, dry_run=False, consult_agent=True)
            logger.info(
                "kb_govern_scheduler policy_id=%s ok=%s advisor=%s docs=%s agent_applied=%s agent_pending=%s updated_rows=%s",
                policy_id,
                result.get("ok"),
                result.get("advisor"),
                result.get("doc_count"),
                result.get("agent_applied"),
                result.get("agent_pending"),
                result.get("updated_rows"),
            )


kb_govern_scheduler = KBGovernScheduler()
