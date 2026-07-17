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
from backend.services.multi_agent_resources import (
    MultiAgentResourceError,
    delete_role as ma_delete_role,
    get_pack as ma_get_pack,
    get_role as ma_get_role,
    list_packs as ma_list_packs,
    list_roles as ma_list_roles,
    save_pack as ma_save_pack,
    save_role as ma_save_role,
)
from backend.services.project_access import require_project_for_user
from backend.services.user_identity import get_effective_user_id

router = APIRouter(prefix="/brainstorm", tags=["brainstorm"])
logger = logging.getLogger("tpdx.hermes.brainstorm.routes")


def _raise_resource(exc: MultiAgentResourceError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

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


# --- P-team / Roles 配置（设置页） ---


class PackIn(BaseModel):
    id: str = Field(..., min_length=1)
    name: str = Field(..., min_length=1)
    description: str = ""
    roundtable_roles: list[dict[str, Any]] = Field(default_factory=list)
    consult_experts: list[dict[str, Any]] = Field(default_factory=list)


class RoleIn(BaseModel):
    id: str = Field(..., min_length=1)
    name: str = Field(..., min_length=1)
    description: str = ""
    kinds: list[str] = Field(default_factory=list)
    perspective: str = ""
    tool: str = ""
    when: str = ""
    system: str = ""


@router.get("/packs")
async def api_list_packs():
    try:
        return await ma_list_packs()
    except MultiAgentResourceError as exc:
        _raise_resource(exc)


@router.get("/packs/{pack_id}")
async def api_get_pack(pack_id: str):
    try:
        return await ma_get_pack(pack_id)
    except MultiAgentResourceError as exc:
        _raise_resource(exc)


@router.post("/packs")
async def api_create_pack(body: PackIn, effective_uid: str = Depends(get_effective_user_id)):
    try:
        data = await ma_save_pack(body.model_dump(), create=True)
        logger.info("创建 Pack | user=%s | id=%s | source=%s", effective_uid, data.get("id"), data.get("source"))
        return data
    except MultiAgentResourceError as exc:
        _raise_resource(exc)


@router.put("/packs/{pack_id}")
async def api_update_pack(
    pack_id: str,
    body: PackIn,
    effective_uid: str = Depends(get_effective_user_id),
):
    payload = body.model_dump()
    payload["id"] = pack_id
    try:
        data = await ma_save_pack(payload, create=False)
        logger.info("更新 Pack | user=%s | id=%s | source=%s", effective_uid, data.get("id"), data.get("source"))
        return data
    except MultiAgentResourceError as exc:
        _raise_resource(exc)


@router.get("/roles")
async def api_list_roles():
    try:
        return await ma_list_roles()
    except MultiAgentResourceError as exc:
        _raise_resource(exc)


@router.get("/roles/{role_id}")
async def api_get_role(role_id: str):
    try:
        return await ma_get_role(role_id)
    except MultiAgentResourceError as exc:
        _raise_resource(exc)


@router.post("/roles")
async def api_create_role(body: RoleIn, effective_uid: str = Depends(get_effective_user_id)):
    try:
        data = await ma_save_role(body.model_dump(), create=True)
        logger.info("创建 Role | user=%s | id=%s | source=%s", effective_uid, data.get("id"), data.get("source"))
        return data
    except MultiAgentResourceError as exc:
        _raise_resource(exc)


@router.put("/roles/{role_id}")
async def api_update_role(
    role_id: str,
    body: RoleIn,
    effective_uid: str = Depends(get_effective_user_id),
):
    payload = body.model_dump()
    payload["id"] = role_id
    try:
        data = await ma_save_role(payload, create=False)
        logger.info("更新 Role | user=%s | id=%s | source=%s", effective_uid, data.get("id"), data.get("source"))
        return data
    except MultiAgentResourceError as exc:
        _raise_resource(exc)


@router.delete("/roles/{role_id}")
async def api_delete_role(role_id: str, effective_uid: str = Depends(get_effective_user_id)):
    try:
        data = await ma_delete_role(role_id)
        logger.info("删除 Role | user=%s | id=%s | source=%s", effective_uid, role_id, data.get("source"))
        return data
    except MultiAgentResourceError as exc:
        _raise_resource(exc)
