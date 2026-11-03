"""技术卡工作区：对话回合交给 Hermes 选择动作。"""

from __future__ import annotations

import logging
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from backend.services.tech_card_studio import resolve_driver, run_studio_turn

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/studio", tags=["studio"])


class StudioTurnRequest(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    state: dict[str, Any] | None = None
    project_id: str | None = None
    file_id: str | None = None
    file_kind: Literal["output", "attachment"] | None = None


@router.get("/config")
async def studio_config() -> dict[str, str]:
    return {"product": "V04", "driver": resolve_driver()}


@router.post("/turn")
async def studio_turn(request: StudioTurnRequest) -> dict[str, Any]:
    result = await run_studio_turn(request.message, request.state)
    log = result.setdefault("log", {})
    if isinstance(log, dict):
        log["project_id"] = request.project_id
        log["file_id"] = request.file_id
        log["file_kind"] = request.file_kind
    logger.info(
        "studio bind project_id=%s file_id=%s file_kind=%s",
        request.project_id or "",
        request.file_id or "",
        request.file_kind or "",
    )
    return result
