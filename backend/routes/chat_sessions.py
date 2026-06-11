"""聊天/场景会话历史（服务端持久化，跨设备按 User ID 同步）。"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import get_db
from backend.services.chat_session_service import (
    create_session_for_user,
    delete_session_for_user,
    get_session_detail_for_user,
    list_sessions_for_user,
    list_sessions_full_for_user,
    migrate_local_sessions,
    patch_session_for_user,
    sync_session_messages_for_user,
    upsert_session_for_user,
)
from backend.services.user_identity import get_effective_user_id

router = APIRouter(prefix="/chat/sessions", tags=["chat-sessions"])
logger = logging.getLogger("tpdx.hermes.chat_sessions")


class ChatSessionPayload(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str | None = None
    title: str = "新对话"
    messages: list[dict[str, Any]] = Field(default_factory=list)
    createdAt: int | None = None
    linkedOutputIds: list[str] | None = None
    linkedRunIds: list[str] | None = None
    sessionKind: str | None = None


class MigrateLocalIn(BaseModel):
    sessions: list[dict[str, Any]] = Field(default_factory=list)


class BulkUpsertIn(BaseModel):
    sessions: list[dict[str, Any]] = Field(default_factory=list)


class ChatSessionPatchPayload(BaseModel):
    model_config = ConfigDict(extra="allow")

    title: str | None = None
    linkedOutputIds: list[str] | None = None
    linkedRunIds: list[str] | None = None
    sessionKind: str | None = None


class SessionMessagesSyncIn(BaseModel):
    model_config = ConfigDict(extra="allow")

    messages: list[dict[str, Any]] = Field(default_factory=list)
    removedMessageIds: list[str] = Field(default_factory=list)


@router.get("")
async def api_list_chat_sessions(
    full: bool = False,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    if full:
        items = await list_sessions_full_for_user(db, effective_uid)
    else:
        items = await list_sessions_for_user(db, effective_uid)
    return {"items": items, "user_id": effective_uid}


@router.get("/{session_id}")
async def api_get_chat_session(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    detail = await get_session_detail_for_user(db, session_id=session_id, user_id=effective_uid)
    if not detail:
        raise HTTPException(404, "会话不存在或无权访问")
    return detail


@router.post("")
async def api_create_chat_session(
    body: ChatSessionPayload,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    detail = await create_session_for_user(db, user_id=effective_uid, payload=body.model_dump())
    return detail


@router.put("/{session_id}")
async def api_upsert_chat_session(
    session_id: str,
    body: ChatSessionPayload,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    payload = body.model_dump()
    payload["id"] = session_id
    detail = await upsert_session_for_user(
        db,
        session_id=session_id,
        user_id=effective_uid,
        payload=payload,
    )
    if not detail:
        raise HTTPException(404, "会话保存失败")
    return detail


@router.patch("/{session_id}")
async def api_patch_chat_session(
    session_id: str,
    body: ChatSessionPatchPayload,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    payload = body.model_dump(exclude_unset=True)
    detail = await patch_session_for_user(
        db,
        session_id=session_id,
        user_id=effective_uid,
        payload=payload,
    )
    if not detail:
        raise HTTPException(404, "会话不存在或无权访问")
    logger.info(
        "chat_session patch user_id=%s session_id=%s payload_bytes=%s",
        effective_uid[:24],
        session_id,
        len(str(payload)),
    )
    return detail


@router.post("/{session_id}/messages/sync")
async def api_sync_chat_session_messages(
    session_id: str,
    body: SessionMessagesSyncIn,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    payload = body.model_dump()
    result = await sync_session_messages_for_user(
        db,
        session_id=session_id,
        user_id=effective_uid,
        messages=payload.get("messages") or [],
        removed_message_ids=payload.get("removedMessageIds") or [],
    )
    if not result:
        raise HTTPException(404, "会话不存在或无权访问")
    logger.info(
        "chat_session message_sync_api user_id=%s session_id=%s payload_bytes=%s message_count=%s removed_count=%s",
        effective_uid[:24],
        session_id,
        len(str(payload)),
        len(payload.get("messages") or []),
        len(payload.get("removedMessageIds") or []),
    )
    return result


@router.delete("/{session_id}")
async def api_delete_chat_session(
    session_id: str,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    ok = await delete_session_for_user(db, session_id=session_id, user_id=effective_uid)
    if not ok:
        raise HTTPException(404, "会话不存在或无权访问")
    return {"ok": True}


@router.post("/migrate-local")
async def api_migrate_local_sessions(
    body: MigrateLocalIn,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    result = await migrate_local_sessions(db, user_id=effective_uid, sessions=body.sessions)
    return {"ok": True, **result, "user_id": effective_uid}


@router.post("/bulk-upsert")
async def api_bulk_upsert_sessions(
    body: BulkUpsertIn,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    count = 0
    payload_bytes = len(body.model_dump_json())
    for item in body.sessions:
        sid = str(item.get("id") or "").strip()
        if not sid:
            continue
        await upsert_session_for_user(db, session_id=sid, user_id=effective_uid, payload=item)
        count += 1
    logger.info(
        "chat_session bulk_upsert user_id=%s count=%s payload_bytes=%s",
        effective_uid[:24],
        count,
        payload_bytes,
    )
    return {"ok": True, "count": count, "user_id": effective_uid}
