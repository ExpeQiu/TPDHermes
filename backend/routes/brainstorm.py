"""头脑风暴 API：桥接独立 multi-agent 圆桌引擎（不代持 Hermes LLM）。"""
from __future__ import annotations

import logging
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import get_db
from backend.services.brainstorm_attachments import build_attachment_context
from backend.services.brainstorm_bridge import (
    BrainstormBridgeError,
    health_check,
    run_roundtable,
)
from backend.services.project_access import require_project_for_user
from backend.services.user_identity import get_effective_user_id

router = APIRouter(prefix="/brainstorm", tags=["brainstorm"])
logger = logging.getLogger("tpdx.hermes.brainstorm.routes")

DiscussionMode = Literal["round_robin", "parallel", "debate"]


class DebateConfigIn(BaseModel):
    pro_role_ids: list[str] = Field(default_factory=list)
    con_role_ids: list[str] = Field(default_factory=list)
    judge_role_id: str | None = None


class BrainstormRunIn(BaseModel):
    topic: str = Field(..., min_length=1, description="圆桌议题")
    project_id: str | None = Field(default=None, description="关联项目（可选，有则校验权限）")
    pack: str = Field(default="nev-tech", description="Skill Pack id")
    rounds: int = Field(default=2, ge=1, le=5, description="辩论轮数")
    demo: bool | None = Field(
        default=None,
        description="透传给 multi-agent 的 Mock 提示；None 则由引擎自行决定",
    )
    discussion_mode: DiscussionMode = Field(
        default="round_robin",
        description="讨论模式：round_robin / parallel / debate",
    )
    consensus_enabled: bool = Field(default=False, description="是否启用共识提前终止")
    consensus_threshold: float = Field(default=0.7, ge=0.5, le=1.0)
    debate_config: DebateConfigIn | None = Field(
        default=None,
        description="辩论模式正反方/裁判角色（可选；缺省由引擎均分）",
    )
    moderator_enabled: bool = Field(default=True)
    attachment_ids: list[str] = Field(
        default_factory=list,
        description="项目附件 ID；Hermes 抽取正文后注入 multi-agent context",
    )


@router.get("/health")
async def brainstorm_health():
    data = await health_check()
    logger.info(
        "头脑风暴健康检查 | ready=%s | http_ok=%s | sdk_ok=%s | ai_owner=%s",
        data.get("ready"),
        data.get("http_ok"),
        data.get("sdk_ok"),
        data.get("ai_owner"),
    )
    return data


@router.post("/run")
async def brainstorm_run(
    body: BrainstormRunIn,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    if body.project_id:
        await require_project_for_user(db, body.project_id, effective_uid, min_perm="read")

    topic = body.topic.strip()
    debate: dict[str, Any] | None = None
    if body.debate_config is not None:
        debate = body.debate_config.model_dump()

    attachment_ctx: dict[str, Any] = {"context_markdown": "", "items": []}
    if body.project_id and body.attachment_ids:
        attachment_ctx = await build_attachment_context(
            db,
            project_id=body.project_id,
            attachment_ids=body.attachment_ids,
        )

    context_md = str(attachment_ctx.get("context_markdown") or "").strip()
    logger.info(
        "头脑风暴启动 | user=%s | project=%s | pack=%s | rounds=%s | mode=%s | consensus=%s | demo=%s | attachments=%s | context_chars=%s | topic=%s",
        effective_uid,
        body.project_id,
        body.pack,
        body.rounds,
        body.discussion_mode,
        body.consensus_enabled,
        body.demo,
        len(body.attachment_ids),
        len(context_md),
        topic[:120],
    )
    try:
        result = await run_roundtable(
            topic,
            pack=body.pack,
            rounds=body.rounds,
            demo=body.demo,
            discussion_mode=body.discussion_mode,
            consensus_enabled=body.consensus_enabled,
            consensus_threshold=body.consensus_threshold,
            debate_config=debate,
            moderator_enabled=body.moderator_enabled,
            context=context_md or None,
        )
    except BrainstormBridgeError as exc:
        logger.warning("头脑风暴失败 | user=%s | err=%s", effective_uid, exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("头脑风暴未预期错误 | user=%s", effective_uid)
        raise HTTPException(status_code=500, detail=f"头脑风暴执行失败: {exc}") from exc

    result["project_id"] = body.project_id
    result["user_id"] = effective_uid
    result["attachment_context"] = attachment_ctx.get("items") or []
    result["context_chars"] = len(context_md)
    logger.info(
        "头脑风暴完成 | user=%s | run_id=%s | bridge=%s | mock=%s | mode=%s | consensus=%s | context_chars=%s",
        effective_uid,
        result.get("run_id"),
        result.get("bridge"),
        result.get("mock"),
        result.get("discussion_mode"),
        result.get("consensus_reached"),
        len(context_md),
    )
    return result
