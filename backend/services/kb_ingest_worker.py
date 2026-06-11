"""
知识库导入后台 worker：轮询 queued 任务并串行执行。
"""

from __future__ import annotations

import asyncio
import logging
import os

from sqlalchemy import select

from backend.db import async_session_maker
from backend.models.kb_ingest_job import KbIngestJob
from backend.services.kb_ingest_job_service import (
    process_ingest_job,
    requeue_running_ingest_jobs,
)

logger = logging.getLogger("tpdx.hermes.kb_ingest_worker")

_ENABLED = os.getenv("KB_INGEST_WORKER_ENABLED", "true").lower() in ("1", "true", "yes")
_TICK_SECONDS = float(os.getenv("KB_INGEST_WORKER_TICK_SECONDS", "2"))


class KBIngestWorker:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._wakeup = asyncio.Event()

    async def start(self) -> None:
        if not _ENABLED:
            logger.info("kb_ingest_worker disabled")
            return
        if self._task and not self._task.done():
            return
        requeued = await requeue_running_ingest_jobs()
        if requeued:
            logger.info("kb_ingest_worker requeued running jobs=%s", requeued)
        self._task = asyncio.create_task(self._loop(), name="kb-ingest-worker")
        logger.info("kb_ingest_worker started tick=%ss", _TICK_SECONDS)

    async def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("kb_ingest_worker stopped")

    async def wakeup(self) -> None:
        self._wakeup.set()

    async def _loop(self) -> None:
        while True:
            try:
                processed = await self._process_next()
                if processed:
                    continue
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("kb_ingest_worker tick failed")
            await self._sleep_or_wakeup()

    async def _sleep_or_wakeup(self) -> None:
        self._wakeup.clear()
        try:
            await asyncio.wait_for(self._wakeup.wait(), timeout=_TICK_SECONDS)
        except asyncio.TimeoutError:
            pass

    async def _next_queued_job_id(self) -> str | None:
        async with async_session_maker() as db:
            row = (
                await db.execute(
                    select(KbIngestJob)
                    .where(KbIngestJob.status == "queued")
                    .order_by(KbIngestJob.created_at.asc())
                    .limit(1)
                )
            ).scalar_one_or_none()
        if not row:
            return None
        return str(row.id)

    async def _process_next(self) -> bool:
        job_id = await self._next_queued_job_id()
        if not job_id:
            return False
        logger.info("kb_ingest_worker processing job=%s", job_id)
        await process_ingest_job(job_id)
        return True


kb_ingest_worker = KBIngestWorker()
