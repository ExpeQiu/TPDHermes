"""技术卡工作区：对话回合交给 Hermes 选择动作。"""

from __future__ import annotations

import logging
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import get_db
from backend.services.tech_card_studio import (
    apply_operation,
    create_state,
    normalize_state,
    parse_command,
)
from backend.services.tpcstore_bridge import call_tpcstore, read_studio_source
from backend.services.user_identity import get_effective_user_id

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/studio", tags=["studio"])


class StudioTurnRequest(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    state: dict[str, Any] | None = None
    project_id: str | None = None
    file_id: str | None = None
    file_kind: Literal["output", "attachment"] | None = None
    demo: bool = False


@router.get("/config")
async def studio_config() -> dict[str, Any]:
    try:
        capabilities = await call_tpcstore("capabilities")
        return {
            "product": "V04",
            "driver": "tpcstore",
            "connected": True,
            **capabilities,
        }
    except HTTPException as exc:
        return {
            "product": "V04",
            "driver": "tpcstore",
            "connected": False,
            "configured": False,
            "reason": exc.detail,
        }


@router.post("/turn")
async def studio_turn(
    request: StudioTurnRequest,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_effective_user_id),
) -> dict[str, Any]:
    operation = parse_command(request.message)
    if request.demo:
        if request.project_id or request.file_id or request.file_kind:
            raise HTTPException(422, "样本演示不能混用真实项目资料")
        result = apply_operation(
            normalize_state(request.state) if request.state else create_state(),
            operation,
            request.message,
        )
        return {
            **result,
            "driver": "mock",
            "fallback_reason": None,
            "persistence": "session_preview",
            "release_authorized": False,
        }
    if not request.project_id or not request.file_id or not request.file_kind:
        raise HTTPException(422, "请选择项目和资料；样本演示需显式开启")
    source = await read_studio_source(
        db, request.project_id, request.file_id, request.file_kind, user_id
    )
    if operation not in {"extract", "gaps", "lock"}:
        raise HTTPException(
            422, "首轮 TPCstore 通路支持提取技术卡、查看缺口、锁定当前卡"
        )
    result = await call_tpcstore(
        "turn",
        {
            "schema_version": "1.0.0",
            "operation": operation,
            "source": source,
            "state": request.state,
            "expected_revision": (request.state or {}).get("revision", 0),
        },
    )
    logger.info(
        "studio tpcstore project_id=%s file_id=%s file_kind=%s",
        request.project_id or "",
        request.file_id or "",
        request.file_kind or "",
    )
    return result
