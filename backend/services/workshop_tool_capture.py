"""工坊 Agent 模式下 MCP tool 结果按 run_id 跨进程落库。"""
from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any

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
        row = await db.get(OrchestrationRun, run_id)
        if row:
            return run_id
        logger.warning("workshop tool capture skipped: run not found run_id=%s", run_id)
        return None

    logger.warning("workshop tool capture skipped: missing tphermes_run_id")
    return None


async def save_workshop_tool_capture_for_context(
    context: dict[str, Any] | None,
    tool_name: str,
    payload: dict[str, Any],
    *,
    skill_name: str | None = None,
) -> None:
    """供 workshop_tools / MCP 调用；context 必须显式携带 tphermes_run_id。"""
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
