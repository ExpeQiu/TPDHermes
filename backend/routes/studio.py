"""技术卡工作区：对话回合交给 Hermes 选择动作。"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from backend.services.tech_card_studio import resolve_driver, run_studio_turn

router = APIRouter(prefix="/studio", tags=["studio"])


class StudioTurnRequest(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    state: dict[str, Any] | None = None


@router.get("/config")
async def studio_config() -> dict[str, str]:
    return {"product": "V04", "driver": resolve_driver()}


@router.post("/turn")
async def studio_turn(request: StudioTurnRequest) -> dict[str, Any]:
    return await run_studio_turn(request.message, request.state)
