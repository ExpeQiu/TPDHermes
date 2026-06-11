"""
知识库全量校准调度：写入链路走增量同步，定时做全量校准。
"""

from __future__ import annotations

import asyncio
import logging
import os

from backend.services.kb_cache import kb_cache_service
from backend.services.kb_proxy import CHROMA_HOST, kb_proxy_service
from backend.services.project_kb import project_id_from_kb_collection

logger = logging.getLogger("tpdx.hermes.kb_reconcile_scheduler")

_ENABLED = os.getenv("KB_RECONCILE_SCHEDULER_ENABLED", "true").lower() in ("1", "true", "yes")
_TICK_SECONDS = int(os.getenv("KB_RECONCILE_INTERVAL_SECONDS", "21600"))


class KBReconcileScheduler:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        if not _ENABLED:
            logger.info("kb_reconcile_scheduler disabled")
            return
        if self._task and not self._task.done():
            return
        self._task = asyncio.create_task(self._loop(), name="kb-reconcile-scheduler")
        logger.info("kb_reconcile_scheduler started interval=%ss", _TICK_SECONDS)

    async def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("kb_reconcile_scheduler stopped")

    async def _loop(self) -> None:
        while True:
            try:
                await self._tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("kb_reconcile_scheduler tick failed")
            await asyncio.sleep(_TICK_SECONDS)

    async def _tick(self) -> None:
        listed = await kb_proxy_service.list_collections(project_id="__all__")
        if listed.get("source") != "chroma":
            logger.info("kb_reconcile_scheduler skipped source=%s", listed.get("source"))
            return
        collections = [str(c).strip() for c in (listed.get("collections") or []) if str(c).strip()]
        for collection in collections:
            project_id = project_id_from_kb_collection(collection) or "__all__"
            await kb_cache_service.sync_from_external(
                external_kb_url=CHROMA_HOST,
                project_id=project_id,
                collections=[collection],
            )
        if collections:
            logger.info("kb_reconcile_scheduler reconciled collections=%s", len(collections))


kb_reconcile_scheduler = KBReconcileScheduler()
