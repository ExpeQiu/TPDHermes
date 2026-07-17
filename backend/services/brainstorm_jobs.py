"""头脑风暴异步任务：避免 live 圆桌长时间占用 HTTP 连接导致客户端超时断连。"""
from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from backend.services.brainstorm_bridge import BrainstormBridgeError, run_roundtable

logger = logging.getLogger("tpdx.hermes.brainstorm.jobs")

# 单进程 uvicorn 下内存任务表即可；重启后未完成任务丢失（可接受）
_jobs: dict[str, dict[str, Any]] = {}
_lock = asyncio.Lock()
_MAX_JOBS = 200


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _prune_locked() -> None:
    if len(_jobs) <= _MAX_JOBS:
        return
    # 删最旧已结束任务
    finished = sorted(
        (
            (jid, j)
            for jid, j in _jobs.items()
            if j.get("status") in {"completed", "failed"}
        ),
        key=lambda x: str(x[1].get("updated_at") or ""),
    )
    overflow = len(_jobs) - _MAX_JOBS
    for jid, _ in finished[: max(0, overflow)]:
        _jobs.pop(jid, None)


async def create_brainstorm_job(params: dict[str, Any]) -> dict[str, Any]:
    job_id = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:8]
    record: dict[str, Any] = {
        "job_id": job_id,
        "status": "queued",
        "created_at": _now(),
        "updated_at": _now(),
        "params_summary": {
            "project_id": params.get("project_id"),
            "pack": params.get("pack"),
            "rounds": params.get("rounds"),
            "discussion_mode": params.get("discussion_mode"),
            "demo": params.get("demo"),
            "topic": str(params.get("topic") or "")[:120],
            "context_chars": len(str(params.get("context") or "")),
        },
        "result": None,
        "error": None,
        "turns": [],
        "ma_run_id": None,
        "title": None,
    }
    async with _lock:
        _prune_locked()
        _jobs[job_id] = record

    logger.info(
        "头脑风暴任务已入队 | job_id=%s | project=%s | rounds=%s | demo=%s | topic=%s",
        job_id,
        params.get("project_id"),
        params.get("rounds"),
        params.get("demo"),
        str(params.get("topic") or "")[:80],
    )
    asyncio.create_task(_execute_job(job_id, params), name=f"brainstorm-{job_id}")
    return {"job_id": job_id, "status": "queued"}


async def get_brainstorm_job(job_id: str) -> dict[str, Any] | None:
    async with _lock:
        job = _jobs.get(job_id)
        if not job:
            return None
        return dict(job)


async def _patch_job(job_id: str, **fields: Any) -> None:
    async with _lock:
        job = _jobs.get(job_id)
        if not job:
            return
        job.update(fields)
        job["updated_at"] = _now()


async def _execute_job(job_id: str, params: dict[str, Any]) -> None:
    await _patch_job(job_id, status="running")
    logger.info("头脑风暴任务开始执行 | job_id=%s", job_id)

    async def on_progress(progress: dict[str, Any]) -> None:
        turns = progress.get("turns") if isinstance(progress.get("turns"), list) else []
        await _patch_job(
            job_id,
            status="running",
            turns=turns,
            ma_run_id=progress.get("run_id"),
            title=progress.get("title"),
        )

    try:
        result = await run_roundtable(
            str(params.get("topic") or ""),
            pack=str(params.get("pack") or "nev-tech"),
            rounds=int(params.get("rounds") or 2),
            demo=params.get("demo"),
            discussion_mode=str(params.get("discussion_mode") or "round_robin"),
            consensus_enabled=bool(params.get("consensus_enabled") or False),
            consensus_threshold=float(params.get("consensus_threshold") or 0.7),
            debate_config=params.get("debate_config"),
            moderator_enabled=bool(params.get("moderator_enabled", True)),
            context=params.get("context"),
            on_progress=on_progress,
        )
        result["project_id"] = params.get("project_id")
        result["user_id"] = params.get("user_id")
        result["attachment_context"] = params.get("attachment_items") or []
        result["context_chars"] = len(str(params.get("context") or ""))
        result["job_id"] = job_id
        final_turns = result.get("live_turns") or []
        await _patch_job(
            job_id,
            status="completed",
            result=result,
            error=None,
            turns=final_turns,
            ma_run_id=result.get("run_id"),
            title=result.get("title"),
        )
        logger.info(
            "头脑风暴任务完成 | job_id=%s | run_id=%s | bridge=%s | mock=%s | turns=%s",
            job_id,
            result.get("run_id"),
            result.get("bridge"),
            result.get("mock"),
            len(final_turns) if isinstance(final_turns, list) else 0,
        )
    except BrainstormBridgeError as exc:
        await _patch_job(job_id, status="failed", error=str(exc), result=None)
        logger.warning("头脑风暴任务桥接失败 | job_id=%s | err=%s", job_id, exc)
    except Exception as exc:  # noqa: BLE001
        await _patch_job(job_id, status="failed", error=f"头脑风暴执行失败: {exc}", result=None)
        logger.exception("头脑风暴任务未预期错误 | job_id=%s", job_id)
