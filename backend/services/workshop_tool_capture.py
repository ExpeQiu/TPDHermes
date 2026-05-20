"""工坊 Agent 模式下 MCP tool 结果按 run_id 跨进程落库。"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import async_session_maker
from backend.models.orchestration_run import OrchestrationRun
from backend.services.workshop_execution import extract_text_from_tool_payload

logger = logging.getLogger("tpdx.hermes")


def _merge_capture(existing: dict[str, Any] | None, artifact: dict[str, Any]) -> dict[str, Any]:
    base = dict(existing or {})
    artifacts = list(base.get("artifacts") or [])
    artifacts.append(artifact)
    base["artifacts"] = artifacts
    text = artifact.get("content_text") or ""
    if text.strip():
        base["primary_content"] = text
    base["updated_at"] = datetime.now().isoformat()
    return base


async def append_workshop_tool_capture(
    db: AsyncSession,
    *,
    run_id: str,
    tool_name: str,
    payload: dict[str, Any],
    skill_name: str | None = None,
) -> None:
    row = await db.get(OrchestrationRun, run_id)
    if not row:
        logger.warning("workshop tool capture skipped: run not found run_id=%s", run_id)
        return

    content_text = extract_text_from_tool_payload(tool_name, payload)
    existing = None
    if row.tool_capture_json:
        try:
            existing = json.loads(row.tool_capture_json)
            if not isinstance(existing, dict):
                existing = None
        except json.JSONDecodeError:
            existing = None

    artifact = {
        "tool": tool_name,
        "skill": skill_name or payload.get("skill"),
        "content_text": content_text,
        "raw": payload,
        "created_at": datetime.now().isoformat(),
    }
    merged = _merge_capture(existing, artifact)
    row.tool_capture_json = json.dumps(merged, ensure_ascii=False)
    row.updated_at = datetime.now().isoformat()
    await db.commit()
    logger.info(
        "workshop tool capture saved run_id=%s tool=%s skill=%s len=%s",
        run_id,
        tool_name,
        skill_name or payload.get("skill"),
        len(content_text),
    )


async def _resolve_run_id_from_context(db: AsyncSession, ctx: dict[str, Any]) -> str | None:
    run_id = (ctx.get("tphermes_run_id") or ctx.get("run_id") or "").strip()
    if run_id:
        return run_id

    project_id = str(ctx.get("project_id") or "").strip()
    task_input = ctx.get("task_input")
    if not project_id and isinstance(task_input, dict):
        project_id = str(task_input.get("project_id") or "").strip()
    if not project_id:
        logger.warning("workshop tool capture skipped: missing tphermes_run_id and project_id")
        return None

    cutoff = (datetime.now() - timedelta(minutes=30)).isoformat()
    q = await db.execute(
        select(OrchestrationRun)
        .where(
            OrchestrationRun.project_id == project_id,
            OrchestrationRun.entrypoint == "workshop",
            OrchestrationRun.created_at >= cutoff,
        )
        .order_by(OrchestrationRun.created_at.desc())
        .limit(5)
    )
    for row in q.scalars():
        if not row.tool_capture_json:
            logger.info(
                "workshop tool capture fallback run_id=%s project_id=%s",
                row.id,
                project_id,
            )
            return row.id
    logger.warning(
        "workshop tool capture skipped: no pending workshop run project_id=%s",
        project_id,
    )
    return None


async def save_workshop_tool_capture_for_context(
    context: dict[str, Any] | None,
    tool_name: str,
    payload: dict[str, Any],
    *,
    skill_name: str | None = None,
) -> None:
    """供 workshop_tools / MCP 调用；context 须含 tphermes_run_id（或 project_id 供降级匹配）。"""
    ctx = context or {}
    async with async_session_maker() as db:
        run_id = await _resolve_run_id_from_context(db, ctx)
        if not run_id:
            return
        await append_workshop_tool_capture(
            db,
            run_id=run_id,
            tool_name=tool_name,
            payload=payload,
            skill_name=skill_name,
        )


async def load_workshop_tool_capture(db: AsyncSession, run_id: str) -> dict[str, Any] | None:
    row = await db.get(OrchestrationRun, run_id)
    if not row or not row.tool_capture_json:
        return None
    try:
        data = json.loads(row.tool_capture_json)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None
