"""
编排执行记录与输出物落库。
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.orchestration_run import OrchestrationRun
from backend.models.output_asset import OutputAsset

logger = logging.getLogger("tpdx.hermes")


async def create_run(
    db: AsyncSession,
    *,
    run_id: str,
    project_id: str | None,
    scenario_id: str | None = None,
    entrypoint: str,
    user_id: str | None = None,
    request_json: str,
    snapshot_json: str,
    skills_policy_json: str | None = None,
) -> OrchestrationRun:
    row = OrchestrationRun(
        id=run_id,
        project_id=project_id,
        scenario_id=scenario_id,
        entrypoint=entrypoint,
        user_id=(user_id or "default"),
        status="running",
        request_json=request_json,
        snapshot_json=snapshot_json,
        skills_policy_json=skills_policy_json,
        created_at=datetime.now().isoformat(),
        updated_at=datetime.now().isoformat(),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    logger.info("run_log created run_id=%s entrypoint=%s", run_id, entrypoint)
    return row


async def finalize_run(
    db: AsyncSession,
    *,
    run_id: str,
    assistant_content: str,
    status: str,
    response_metadata: dict[str, Any] | None,
    validation: dict[str, Any] | None,
    error_message: str | None,
    duration_ms: int | None,
    project_id: str | None,
    scenario_id: str | None = None,
    template_id: str | None,
    save_output: bool,
    output_title: str | None = None,
    output_owner_id: str | None = None,
) -> tuple[OrchestrationRun, str | None]:
    """
    更新 run；若 save_output 且校验通过则写入 outputs，返回 output_id。
    """
    res = await db.get(OrchestrationRun, run_id)
    if not res:
        raise ValueError("run not found")

    res.assistant_content = assistant_content
    res.status = status
    res.response_metadata_json = json.dumps(response_metadata or {}, ensure_ascii=False)
    res.validation_json = json.dumps(validation or {}, ensure_ascii=False)
    res.error_message = error_message
    res.duration_ms = duration_ms
    res.updated_at = datetime.now().isoformat()

    output_id: str | None = None
    validation_ok = bool((validation or {}).get("ok", True))

    if save_output and project_id and project_id != "none" and validation_ok and assistant_content.strip():
        raw_st = (status or "completed").strip().lower()
        if raw_st in ("completed", "draft", "approved"):
            out_status = raw_st
        elif raw_st == "failed":
            out_status = "draft"
        else:
            out_status = "completed"
        out = OutputAsset(
            id=str(uuid.uuid4()),
            project_id=project_id,
            scenario_id=scenario_id,
            template_id=template_id,
            run_id=run_id,
            title=output_title or "编排生成",
            summary=assistant_content.strip()[:280],
            content=assistant_content,
            content_format="markdown",
            status=out_status,
            citations_json=None,
            owner_id=(output_owner_id or "default"),
        )
        db.add(out)
        await db.flush()
        output_id = out.id
        logger.info("output saved output_id=%s run_id=%s status=%s", output_id, run_id, out_status)
    elif save_output and not validation_ok:
        res.status = "draft"
        logger.info("output skipped due to validation run_id=%s", run_id)

    await db.commit()
    await db.refresh(res)
    return res, output_id


async def mark_run_failed(db: AsyncSession, run_id: str, message: str) -> None:
    res = await db.get(OrchestrationRun, run_id)
    if not res:
        return
    res.status = "failed"
    res.error_message = message
    res.updated_at = datetime.now().isoformat()
    await db.commit()
