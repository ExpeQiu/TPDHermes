"""聊天会话 CRUD（服务端持久化，按 user_id 隔离）。"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.chat_session import ChatMessageRecord, ChatSessionRecord

logger = logging.getLogger("tpdx.hermes.chat_sessions")

SESSION_KIND_CHAT = "chat"
SESSION_KIND_SCENARIO = "scenario"


def _json_dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def _json_load(raw: str | None, default: Any) -> Any:
    if not raw:
        return default
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return default


def infer_session_kind(context: dict[str, Any]) -> str:
    if context.get("scenarioPresetInstructions") or context.get("quickCreateOverrides"):
        return SESSION_KIND_SCENARIO
    if context.get("taskEntrySummary"):
        return SESSION_KIND_SCENARIO
    return SESSION_KIND_CHAT


def message_record_to_dict(row: ChatMessageRecord) -> dict[str, Any]:
    meta = _json_load(row.metadata_json, {})
    out: dict[str, Any] = {
        "id": row.id,
        "role": row.role,
        "content": row.content or "",
    }
    for key in (
        "toolsContext",
        "contextBlocks",
        "contextWarnings",
        "runId",
        "outputId",
        "feedbackLevel",
    ):
        if key in meta and meta[key] is not None:
            out[key] = meta[key]
    return out


def session_record_to_summary(row: ChatSessionRecord, *, message_count: int = 0) -> dict[str, Any]:
    return {
        "id": row.id,
        "title": row.title,
        "sessionKind": row.session_kind or SESSION_KIND_CHAT,
        "createdAt": row.created_at_ms,
        "updatedAt": row.updated_at,
        "messageCount": message_count,
    }


def session_records_to_client(
    row: ChatSessionRecord,
    messages: list[ChatMessageRecord],
) -> dict[str, Any]:
    context = _json_load(row.context_json, {})
    linked_output_ids = _json_load(row.linked_output_ids_json, [])
    linked_run_ids = _json_load(row.linked_run_ids_json, [])
    return {
        "id": row.id,
        "title": row.title,
        "messages": [message_record_to_dict(m) for m in messages],
        "createdAt": row.created_at_ms,
        "linkedOutputIds": linked_output_ids if isinstance(linked_output_ids, list) else [],
        "linkedRunIds": linked_run_ids if isinstance(linked_run_ids, list) else [],
        **context,
    }


def client_session_to_context_fields(payload: dict[str, Any]) -> dict[str, Any]:
    reserved = {
        "id",
        "title",
        "messages",
        "createdAt",
        "linkedOutputIds",
        "linkedRunIds",
        "sessionKind",
    }
    return {k: v for k, v in payload.items() if k not in reserved}


def message_client_to_metadata(msg: dict[str, Any]) -> dict[str, Any]:
    meta: dict[str, Any] = {}
    for key in (
        "toolsContext",
        "contextBlocks",
        "contextWarnings",
        "runId",
        "outputId",
        "feedbackLevel",
    ):
        if key in msg and msg[key] is not None:
            meta[key] = msg[key]
    return meta


async def list_sessions_for_user(db: AsyncSession, user_id: str) -> list[dict[str, Any]]:
    rows = (
        await db.execute(
            select(ChatSessionRecord)
            .where(ChatSessionRecord.user_id == user_id)
            .order_by(ChatSessionRecord.updated_at.desc())
        )
    ).scalars().all()
    out: list[dict[str, Any]] = []
    for row in rows:
        count = (
            await db.execute(
                select(ChatMessageRecord.id).where(ChatMessageRecord.session_id == row.id)
            )
        ).scalars().all()
        out.append(session_record_to_summary(row, message_count=len(count)))
    return out


async def get_session_for_user(
    db: AsyncSession,
    *,
    session_id: str,
    user_id: str,
) -> ChatSessionRecord | None:
    row = (
        await db.execute(
            select(ChatSessionRecord).where(
                ChatSessionRecord.id == session_id,
                ChatSessionRecord.user_id == user_id,
            )
        )
    ).scalar_one_or_none()
    return row


async def get_session_detail_for_user(
    db: AsyncSession,
    *,
    session_id: str,
    user_id: str,
) -> dict[str, Any] | None:
    row = await get_session_for_user(db, session_id=session_id, user_id=user_id)
    if not row:
        return None
    messages = (
        await db.execute(
            select(ChatMessageRecord)
            .where(ChatMessageRecord.session_id == session_id)
            .order_by(ChatMessageRecord.sort_index.asc(), ChatMessageRecord.created_at.asc())
        )
    ).scalars().all()
    return session_records_to_client(row, list(messages))


async def list_sessions_full_for_user(db: AsyncSession, user_id: str) -> list[dict[str, Any]]:
    rows = (
        await db.execute(
            select(ChatSessionRecord)
            .where(ChatSessionRecord.user_id == user_id)
            .order_by(ChatSessionRecord.updated_at.desc())
        )
    ).scalars().all()
    out: list[dict[str, Any]] = []
    for row in rows:
        messages = (
            await db.execute(
                select(ChatMessageRecord)
                .where(ChatMessageRecord.session_id == row.id)
                .order_by(ChatMessageRecord.sort_index.asc(), ChatMessageRecord.created_at.asc())
            )
        ).scalars().all()
        out.append(session_records_to_client(row, list(messages)))
    return out


async def create_session_for_user(
    db: AsyncSession,
    *,
    user_id: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    session_id = str(payload.get("id") or "").strip() or None
    context = client_session_to_context_fields(payload)
    now = datetime.now().isoformat()
    row_kwargs: dict[str, Any] = {
        "user_id": user_id,
        "title": str(payload.get("title") or "新对话"),
        "session_kind": str(payload.get("sessionKind") or infer_session_kind(context)),
        "context_json": _json_dump(context),
        "linked_output_ids_json": _json_dump(payload.get("linkedOutputIds") or []),
        "linked_run_ids_json": _json_dump(payload.get("linkedRunIds") or []),
        "created_at_ms": int(payload.get("createdAt") or int(datetime.now().timestamp() * 1000)),
        "updated_at": now,
        "created_at": now,
    }
    if session_id:
        row_kwargs["id"] = session_id
    row = ChatSessionRecord(**row_kwargs)
    db.add(row)
    await db.flush()
    messages = payload.get("messages") or []
    if isinstance(messages, list):
        await _replace_messages(db, row.id, messages)
    await db.commit()
    detail = await get_session_detail_for_user(db, session_id=row.id, user_id=user_id)
    logger.info("chat_session created id=%s user_id=%s", row.id, user_id[:24])
    return detail or {}


async def upsert_session_for_user(
    db: AsyncSession,
    *,
    session_id: str,
    user_id: str,
    payload: dict[str, Any],
) -> dict[str, Any] | None:
    row = await get_session_for_user(db, session_id=session_id, user_id=user_id)
    context = client_session_to_context_fields(payload)
    now = datetime.now().isoformat()
    if row is None:
        row = ChatSessionRecord(
            id=session_id,
            user_id=user_id,
            title=str(payload.get("title") or "新对话"),
            session_kind=str(payload.get("sessionKind") or infer_session_kind(context)),
            context_json=_json_dump(context),
            linked_output_ids_json=_json_dump(payload.get("linkedOutputIds") or []),
            linked_run_ids_json=_json_dump(payload.get("linkedRunIds") or []),
            created_at_ms=int(payload.get("createdAt") or int(datetime.now().timestamp() * 1000)),
            updated_at=now,
            created_at=now,
        )
        db.add(row)
    else:
        row.title = str(payload.get("title") or row.title or "新对话")
        row.session_kind = str(payload.get("sessionKind") or infer_session_kind(context))
        row.context_json = _json_dump(context)
        row.linked_output_ids_json = _json_dump(payload.get("linkedOutputIds") or [])
        row.linked_run_ids_json = _json_dump(payload.get("linkedRunIds") or [])
        row.updated_at = now
    await db.flush()
    messages = payload.get("messages")
    if isinstance(messages, list):
        await _replace_messages(db, session_id, messages)
    await db.commit()
    detail = await get_session_detail_for_user(db, session_id=session_id, user_id=user_id)
    logger.debug("chat_session upsert id=%s user_id=%s msgs=%s", session_id, user_id[:24], len(messages or []))
    return detail


async def delete_session_for_user(
    db: AsyncSession,
    *,
    session_id: str,
    user_id: str,
) -> bool:
    row = await get_session_for_user(db, session_id=session_id, user_id=user_id)
    if not row:
        return False
    await db.execute(delete(ChatMessageRecord).where(ChatMessageRecord.session_id == session_id))
    await db.delete(row)
    await db.commit()
    logger.info("chat_session deleted id=%s user_id=%s", session_id, user_id[:24])
    return True


async def migrate_local_sessions(
    db: AsyncSession,
    *,
    user_id: str,
    sessions: list[dict[str, Any]],
) -> dict[str, Any]:
    imported = 0
    skipped = 0
    for item in sessions:
        sid = str(item.get("id") or "").strip()
        if not sid:
            skipped += 1
            continue
        existing = await get_session_for_user(db, session_id=sid, user_id=user_id)
        if existing:
            skipped += 1
            continue
        await upsert_session_for_user(db, session_id=sid, user_id=user_id, payload=item)
        imported += 1
    logger.info(
        "chat_session migrate user_id=%s imported=%s skipped=%s",
        user_id[:24],
        imported,
        skipped,
    )
    return {"imported": imported, "skipped": skipped}


async def _replace_messages(db: AsyncSession, session_id: str, messages: list[Any]) -> None:
    await db.execute(delete(ChatMessageRecord).where(ChatMessageRecord.session_id == session_id))
    for idx, raw in enumerate(messages):
        if not isinstance(raw, dict):
            continue
        msg_id = str(raw.get("id") or "").strip()
        if not msg_id:
            continue
        db.add(
            ChatMessageRecord(
                id=msg_id,
                session_id=session_id,
                role=str(raw.get("role") or "user"),
                content=str(raw.get("content") or ""),
                metadata_json=_json_dump(message_client_to_metadata(raw)),
                sort_index=idx,
            )
        )
