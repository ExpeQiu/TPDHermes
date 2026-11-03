"""项目共创群聊：人话先落库，Agent 按房间串行回复，主笔收束右侧文档。"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import uuid
from datetime import datetime, timedelta
from typing import Any, Awaitable, Callable

from fastapi import BackgroundTasks, HTTPException
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import async_session_maker
from backend.models.output_asset import OutputAsset
from backend.models.project import Project
from backend.models.project_file_domain import ProjectFileActionLog
from backend.models.project_member import ProjectMember
from backend.models.project_room import ProjectRoom, ProjectRoomMessage
from backend.services.file_action_service import FileActionConflict, FileNameConflict, apply_file_action
from backend.services.multi_agent_resources import MultiAgentResourceError, get_role, list_roles
from backend.services.project_access import require_project_for_user
from backend.services.project_kb_ingest import schedule_ingest_output
from backend.services.rbac import project_perm_allowed
from backend.services.room_contract import (
    allows_file_write,
    delivery_document,
    is_plan_confirm,
    resolve_room_files,
    writer_driver_name,
)
from backend.services.room_writer import complete_with_hermes

logger = logging.getLogger("tpdx.hermes.co_create_room")

MENTION_RE = re.compile(r"@([^\s@]+)")
_AGENT_MODES = {"ask", "agent", "plan"}
_TERMINAL_TURN_STATES = {"succeeded", "failed", "cancelled", "done"}
_LEASE_SECONDS = int(os.getenv("ROOM_TURN_LEASE_SECONDS", "120"))
_MAX_TURN_RETRY = int(os.getenv("ROOM_TURN_MAX_RETRY", "3"))
RoomCompleter = Callable[[dict[str, Any], dict[str, Any]], Awaitable[str]]
TurnHook = Callable[[], Awaitable[None]]

_room_locks: dict[str, asyncio.Lock] = {}
_completer: RoomCompleter | None = None
_turn_commit_hook: TurnHook | None = None


def normalize_room_agent_mode(value: str | None) -> str:
    mode = (value or "agent").strip().lower()
    return mode if mode in _AGENT_MODES else "agent"


_DOC_NEED_RE = re.compile(r"写一版|写一稿|生成|产出|成稿|修订|改写|起草|落稿|删除原句|正式稿")


def agent_turn_needs_document(text: str) -> bool:
    """Agent 按需写文档：确认执行，或明确要求产出/修订。"""
    raw = (text or "").strip()
    if is_plan_confirm(raw):
        return True
    return bool(_DOC_NEED_RE.search(raw))


def effective_room_mode(mode: str, text: str) -> str:
    """回复语气：已确认的计划按执行口吻回答。是否落稿由 allows_file_write 决定。"""
    resolved = normalize_room_agent_mode(mode)
    if is_plan_confirm(text) and resolved != "ask":
        return "agent"
    return resolved


def room_turn_writes_document(mode: str, text: str) -> bool:
    allowed, _reason = allows_file_write(
        mode=normalize_room_agent_mode(mode),
        text=text,
        has_plan=False,
        plan_version=0,
        confirm_plan_version=None,
        archived=False,
    )
    if is_plan_confirm(text):
        return False
    return allowed


def set_room_completer_for_tests(fn: RoomCompleter | None) -> None:
    global _completer
    _completer = fn


def set_turn_commit_hook_for_tests(fn: TurnHook | None) -> None:
    global _turn_commit_hook
    _turn_commit_hook = fn


def _lock_for(room_id: str) -> asyncio.Lock:
    lock = _room_locks.get(room_id)
    if lock is None:
        lock = asyncio.Lock()
        _room_locks[room_id] = lock
    return lock


def _loads(raw: str | None, fallback: list) -> list:
    if not raw:
        return list(fallback)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return list(fallback)
    return data if isinstance(data, list) else list(fallback)


def _now() -> str:
    return datetime.now().isoformat()


def message_to_dict(row: ProjectRoomMessage) -> dict[str, Any]:
    return {
        "id": row.id,
        "room_id": row.room_id,
        "seq": row.seq,
        "turn_id": row.turn_id,
        "author_type": row.author_type,
        "author_id": row.author_id,
        "author_name": row.author_name,
        "content": row.content or "",
        "mention_role_ids": _loads(row.mention_role_ids_json, []),
        "mention_user_ids": _loads(row.mention_user_ids_json, []),
        "mention_file_ids": _loads(row.mention_file_ids_json, []),
        "file_actions": _loads(row.file_actions_json, []),
        "agent_mode": normalize_room_agent_mode(getattr(row, "agent_mode", None)),
        "turn_state": row.turn_state,
        "client_message_id": getattr(row, "client_message_id", None) or "",
        "event_seq": int(getattr(row, "event_seq", 0) or 0),
        "error_summary": getattr(row, "error_summary", "") or "",
        "error_code": getattr(row, "error_code", None),
        "warnings": _loads(getattr(row, "warnings_json", None), []),
        "materials": _loads(getattr(row, "materials_json", None), []),
        "run_id": getattr(row, "run_id", None) or "",
        "created_at": row.created_at,
        "replayed": False,
    }


def room_to_dict(row: ProjectRoom, *, content: str = "") -> dict[str, Any]:
    return {
        "id": row.id,
        "project_id": row.project_id,
        "title": row.title,
        "created_by": row.created_by,
        "role_ids": _loads(row.role_ids_json, []),
        "writer_role_id": row.writer_role_id or "",
        "output_id": row.output_id,
        "doc_version": int(row.doc_version or 0),
        "content": content,
        "active_turn_id": row.active_turn_id,
        "archived_at": row.archived_at,
        "plan_id": getattr(row, "plan_id", None) or "",
        "plan_version": int(getattr(row, "plan_version", 0) or 0),
        "plan_summary": getattr(row, "plan_summary", "") or "",
        "plan_confirmed_version": getattr(row, "plan_confirmed_version", None),
        "writer_driver": writer_driver_name(),
        "latest_event": int(getattr(row, "event_counter", 0) or 0),
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


async def _project_role(db: AsyncSession, project_id: str, user_id: str) -> str:
    project = await require_project_for_user(db, project_id, user_id, min_perm="read")
    from backend.services.project_member_service import get_project_role

    role = await get_project_role(db, project_id=project_id, user_id=user_id, project=project)
    if not role:
        raise HTTPException(status_code=404, detail="Project not found")
    return role


async def _require_room(db: AsyncSession, project_id: str, room_id: str) -> ProjectRoom:
    room = await db.get(ProjectRoom, room_id)
    if not room or room.project_id != project_id:
        raise HTTPException(status_code=404, detail="共创对话不存在")
    return room


async def _member_ids(db: AsyncSession, project_id: str) -> list[str]:
    rows = (
        await db.execute(select(ProjectMember.user_id).where(ProjectMember.project_id == project_id))
    ).scalars().all()
    return [str(item) for item in rows]


async def _catalog_roles() -> list[dict[str, Any]]:
    try:
        data = await list_roles()
    except MultiAgentResourceError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    items = data.get("items") if isinstance(data, dict) else []
    return [item for item in items or [] if isinstance(item, dict) and item.get("id")]


async def _role_detail(role_id: str) -> dict[str, Any]:
    try:
        data = await get_role(role_id)
    except MultiAgentResourceError as exc:
        logger.warning("[co-create-room] role missing role_id=%s err=%s", role_id, exc)
        return {"id": role_id, "name": role_id, "system": "", "missing": True}
    if not isinstance(data, dict):
        return {"id": role_id, "name": role_id, "system": "", "missing": True}
    data.setdefault("id", role_id)
    data.setdefault("name", role_id)
    return data


def resolve_mentions(
    content: str,
    *,
    roles: list[dict[str, Any]],
    member_ids: list[str],
    explicit_role_ids: list[str] | None = None,
    explicit_user_ids: list[str] | None = None,
) -> tuple[list[str], list[str]]:
    by_key: dict[str, str] = {}
    seated: set[str] = set()
    for role in roles:
        rid = str(role.get("id") or "").strip()
        if not rid:
            continue
        seated.add(rid)
        by_key[rid.lower()] = rid
        name = str(role.get("name") or "").strip()
        if name:
            by_key[name.lower()] = rid
    role_ids: list[str] = []
    for raw in explicit_role_ids or []:
        rid = by_key.get(str(raw).strip().lower(), "")
        if rid and rid not in role_ids:
            role_ids.append(rid)
    user_ids: list[str] = []
    members = set(member_ids)
    for raw in explicit_user_ids or []:
        uid = str(raw).strip()
        if uid in members and uid not in user_ids:
            user_ids.append(uid)
    for token in MENTION_RE.findall(content or ""):
        rid = by_key.get(token.lower())
        if rid and rid not in role_ids:
            role_ids.append(rid)
            continue
        if token in members and token not in user_ids:
            user_ids.append(token)
    return [rid for rid in role_ids if rid in seated], user_ids


def speaker_role_ids(mentioned: list[str], writer_role_id: str) -> list[str]:
    """未 @ 时只由主笔接话；@ 到的角色按顺序发言，主笔若被点名则排在最后收束。"""
    writer = (writer_role_id or "").strip()
    if not mentioned:
        return [writer] if writer else []
    speakers = [rid for rid in mentioned if rid != writer]
    if writer and writer in mentioned:
        speakers.append(writer)
    return speakers


def compose_room_document(
    *,
    title: str,
    previous: str,
    human_text: str,
    discussion: list[tuple[str, str]],
) -> str:
    """正式稿只收主笔交付。讨论留在消息里，不再追加到正文。"""
    del previous, human_text
    delivery = ""
    if discussion:
        delivery = discussion[-1][1]
    return delivery_document(title, delivery)


async def mock_room_reply(role: dict[str, Any], ctx: dict[str, Any]) -> str:
    name = str(role.get("name") or role.get("id") or "角色")
    human = str(ctx.get("human_text") or "").strip()
    prior = str(ctx.get("prior_agent_text") or "")
    mode = effective_room_mode(str(ctx.get("agent_mode") or "agent"), human)
    transcript = ctx.get("transcript") or []
    seen = f"\n已看到：{transcript[-1]}" if transcript else ""
    if mode == "ask":
        brief = human[:80]
        line = f"简答：{brief}"
        if prior:
            line += f"\n承接：{prior[:80]}"
        return line + seen
    if mode == "plan":
        return (
            f"需求：{human}\n"
            "拆解：\n1. 澄清目标与约束\n2. 拆成可执行步骤\n3. 排定先后\n"
            "行动计划：\n- [ ] 确认范围\n- [ ] 产出结果\n"
            "请确认后开始执行。"
            + seen
        )
    if ctx.get("is_writer"):
        line = f"主笔收束：{human}"
    else:
        line = f"{name}回应：{human}"
    if prior:
        line += f"\n承接：{prior}"
    if agent_turn_needs_document(human):
        line += "\n已按需写入右侧文档。"
    return line + seen


async def complete_room_turn(role: dict[str, Any], ctx: dict[str, Any]) -> str:
    if _completer is not None:
        return await _completer(role, ctx)
    driver = writer_driver_name()
    if driver == "mock":
        logger.info("[co-create-room] writer driver=mock role_id=%s", role.get("id"))
        return await mock_room_reply(role, ctx)
    logger.info("[co-create-room] writer driver=%s role_id=%s", driver, role.get("id"))
    return await complete_with_hermes(role, ctx)


async def _alloc_human_seq(db: AsyncSession, room_id: str) -> tuple[int, int]:
    """房间行上的计数与消息插入同一事务。进程锁不能代替这次更新。"""
    result = await db.execute(
        text(
            """
            UPDATE project_rooms
            SET seq_counter = MAX(
                  COALESCE(seq_counter, 0),
                  COALESCE((SELECT MAX(seq) FROM project_room_messages WHERE room_id = :room_id), 0)
                ) + 1000,
                event_counter = COALESCE(event_counter, 0) + 1
            WHERE id = :room_id
            RETURNING seq_counter, event_counter
            """
        ),
        {"room_id": room_id},
    )
    row = result.one()
    return int(row.seq_counter), int(row.event_counter)


async def _alloc_event_seq(db: AsyncSession, room_id: str) -> int:
    result = await db.execute(
        text(
            """
            UPDATE project_rooms
            SET event_counter = COALESCE(event_counter, 0) + 1
            WHERE id = :room_id
            RETURNING event_counter
            """
        ),
        {"room_id": room_id},
    )
    return int(result.scalar_one())


async def _alloc_agent_seq(db: AsyncSession, room_id: str, human_seq: int) -> int:
    current = await db.scalar(
        select(func.max(ProjectRoomMessage.seq)).where(
            ProjectRoomMessage.room_id == room_id,
            ProjectRoomMessage.seq >= human_seq,
            ProjectRoomMessage.seq < human_seq + 1000,
        )
    )
    return int(current or human_seq) + 1


async def _output_content(db: AsyncSession, output_id: str | None) -> str:
    if not output_id:
        return ""
    row = await db.get(OutputAsset, output_id)
    return (row.content or "") if row else ""


async def create_room(
    db: AsyncSession,
    *,
    project_id: str,
    user_id: str,
    title: str,
    role_ids: list[str],
    writer_role_id: str,
) -> dict[str, Any]:
    await _project_role(db, project_id, user_id)
    project = await require_project_for_user(db, project_id, user_id, min_perm="write")
    cleaned = []
    for raw in role_ids:
        rid = str(raw).strip()
        if rid and rid not in cleaned:
            cleaned.append(rid)
    writer = str(writer_role_id or "").strip()
    if cleaned:
        catalog = await _catalog_roles()
        known = {str(item["id"]) for item in catalog}
        missing = [rid for rid in cleaned if rid not in known]
        if missing:
            raise HTTPException(status_code=400, detail=f"角色不在配置 Roles 中: {', '.join(missing)}")
        if writer and writer not in cleaned:
            raise HTTPException(status_code=400, detail="主笔必须是已入座角色")
        if not writer:
            writer = cleaned[0]
    now = _now()
    room = ProjectRoom(
        id=str(uuid.uuid4()),
        project_id=project_id,
        title=(title or "").strip() or "共创对话",
        created_by=user_id,
        role_ids_json=json.dumps(cleaned, ensure_ascii=False),
        writer_role_id=writer,
        output_id=None,
        doc_version=0,
        active_turn_id=None,
        created_at=now,
        updated_at=now,
    )
    db.add(room)
    await db.commit()
    logger.info(
        "[co-create-room] room created room_id=%s project_id=%s user_id=%s roles=%s writer=%s",
        room.id,
        project.id,
        user_id,
        ",".join(cleaned),
        writer,
    )
    return room_to_dict(room, content="")


async def update_room(
    db: AsyncSession,
    *,
    project_id: str,
    room_id: str,
    user_id: str,
    title: str | None = None,
    archived: bool | None = None,
) -> dict[str, Any]:
    role = await _project_role(db, project_id, user_id)
    if not project_perm_allowed(role, "write"):
        raise HTTPException(status_code=404, detail="Project not found")
    room = await _require_room(db, project_id, room_id)
    changed: list[str] = []
    if title is not None:
        cleaned = title.strip()
        if not cleaned:
            raise HTTPException(status_code=400, detail="名称不能为空")
        if len(cleaned) > 80:
            raise HTTPException(status_code=400, detail="名称过长")
        room.title = cleaned
        changed.append("rename")
    if archived is True and not room.archived_at:
        room.archived_at = _now()
        changed.append("archive")
    elif archived is False and room.archived_at:
        room.archived_at = None
        changed.append("restore")
    if changed:
        room.updated_at = _now()
        await db.commit()
        logger.info(
            "[co-create-room] room updated room_id=%s project_id=%s user_id=%s changes=%s title=%s archived=%s",
            room.id,
            project_id,
            user_id,
            ",".join(changed),
            room.title,
            bool(room.archived_at),
        )
    return room_to_dict(room, content=await _output_content(db, room.output_id))


async def list_rooms(db: AsyncSession, *, project_id: str, user_id: str) -> list[dict[str, Any]]:
    await _project_role(db, project_id, user_id)
    rows = (
        await db.execute(
            select(ProjectRoom)
            .where(ProjectRoom.project_id == project_id)
            .order_by(ProjectRoom.updated_at.desc())
        )
    ).scalars().all()
    logger.info(
        "[co-create-room] list rooms project_id=%s user_id=%s count=%s",
        project_id,
        user_id,
        len(rows),
    )
    return [room_to_dict(row) for row in rows]


async def get_room(
    db: AsyncSession,
    *,
    project_id: str,
    room_id: str,
    user_id: str,
) -> dict[str, Any]:
    await _project_role(db, project_id, user_id)
    room = await _require_room(db, project_id, room_id)
    content = await _output_content(db, room.output_id)
    return room_to_dict(room, content=content)


async def list_messages(
    db: AsyncSession,
    *,
    project_id: str,
    room_id: str,
    user_id: str,
    after_seq: int = 0,
    after_event: int | None = None,
    known_doc_version: int | None = None,
) -> dict[str, Any]:
    await _project_role(db, project_id, user_id)
    room = await _require_room(db, project_id, room_id)
    filters = [ProjectRoomMessage.room_id == room_id]
    if after_event is not None:
        filters.append(ProjectRoomMessage.event_seq > after_event)
    elif after_seq:
        filters.append(ProjectRoomMessage.seq > after_seq)
    rows = (
        await db.execute(
            select(ProjectRoomMessage).where(*filters).order_by(ProjectRoomMessage.seq.asc())
        )
    ).scalars().all()
    version = int(room.doc_version or 0)
    include_content = known_doc_version is None or int(known_doc_version) != version
    content = await _output_content(db, room.output_id) if include_content else ""
    logger.info(
        "[co-create-room] list messages room_id=%s project_id=%s user_id=%s after_seq=%s after_event=%s count=%s content=%s",
        room_id,
        project_id,
        user_id,
        after_seq,
        after_event,
        len(rows),
        include_content,
    )
    payload = room_to_dict(room, content=content)
    payload["content_omitted"] = not include_content
    payload["messages"] = [message_to_dict(row) for row in rows]
    return payload


async def _find_client_message(
    db: AsyncSession,
    *,
    room_id: str,
    user_id: str,
    client_message_id: str,
) -> ProjectRoomMessage | None:
    return (
        await db.execute(
            select(ProjectRoomMessage).where(
                ProjectRoomMessage.room_id == room_id,
                ProjectRoomMessage.author_id == user_id,
                ProjectRoomMessage.client_message_id == client_message_id,
                ProjectRoomMessage.author_type == "human",
            )
        )
    ).scalar_one_or_none()


async def enqueue_human_message(
    db: AsyncSession,
    *,
    project_id: str,
    room_id: str,
    user_id: str,
    content: str,
    mention_role_ids: list[str] | None = None,
    mention_user_ids: list[str] | None = None,
    mention_file_ids: list[str] | None = None,
    agent_mode: str | None = None,
    client_message_id: str | None = None,
    files: list[dict[str, Any]] | None = None,
    plan_id: str | None = None,
    plan_version: int | None = None,
) -> dict[str, Any]:
    role = await _project_role(db, project_id, user_id)
    if not project_perm_allowed(role, "read"):
        raise HTTPException(status_code=404, detail="Project not found")
    text = (content or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="发言不能为空")
    room = await _require_room(db, project_id, room_id)
    client_id = (client_message_id or "").strip()
    if client_id:
        existing = await _find_client_message(db, room_id=room_id, user_id=user_id, client_message_id=client_id)
        if existing:
            if (existing.content or "") != text:
                raise HTTPException(status_code=409, detail="同一消息标识不能复用不同正文")
            payload = message_to_dict(existing)
            payload["replayed"] = True
            logger.info(
                "[co-create-room] message replay room_id=%s project_id=%s user_id=%s client_message_id=%s",
                room_id,
                project_id,
                user_id,
                client_id,
            )
            return payload
    seated_ids = _loads(room.role_ids_json, [])
    requested = [str(item).strip() for item in (mention_role_ids or []) if str(item).strip()]
    unseated = [rid for rid in requested if rid not in seated_ids]
    if unseated:
        raise HTTPException(status_code=400, detail={"message": "角色未入座，不能唤起", "role_ids": unseated})
    seated_roles = [await _role_detail(rid) for rid in seated_ids]
    members = await _member_ids(db, project_id)
    roles, users = resolve_mentions(
        text,
        roles=seated_roles,
        member_ids=members,
        explicit_role_ids=requested,
        explicit_user_ids=mention_user_ids,
    )
    materials = await resolve_room_files(
        db,
        project_id=project_id,
        files=files,
        mention_file_ids=mention_file_ids,
    )
    file_ids = [item["file_id"] for item in materials]
    mode = normalize_room_agent_mode(agent_mode)
    turn_id = str(uuid.uuid4())
    seq, event_seq = await _alloc_human_seq(db, room_id)
    state = "queued" if room.active_turn_id else "running"
    if state == "running":
        room.active_turn_id = turn_id
        room.lease_until = _lease_deadline()
    now = _now()
    row = ProjectRoomMessage(
        id=str(uuid.uuid4()),
        room_id=room_id,
        seq=seq,
        event_seq=event_seq,
        turn_id=turn_id,
        author_type="human",
        author_id=user_id,
        author_name=user_id,
        content=text,
        mention_role_ids_json=json.dumps(roles, ensure_ascii=False),
        mention_user_ids_json=json.dumps(users, ensure_ascii=False),
        mention_file_ids_json=json.dumps(file_ids, ensure_ascii=False),
        materials_json=json.dumps(materials, ensure_ascii=False),
        warnings_json="[]",
        file_actions_json="[]",
        agent_mode=mode,
        turn_state=state,
        client_message_id=client_id or None,
        plan_id=(plan_id or "").strip() or None,
        plan_version=plan_version,
        created_at=now,
    )
    room.updated_at = now
    db.add(row)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        if client_id:
            existing = await _find_client_message(
                db, room_id=room_id, user_id=user_id, client_message_id=client_id
            )
            if existing and (existing.content or "") == text:
                payload = message_to_dict(existing)
                payload["replayed"] = True
                return payload
            if existing:
                raise HTTPException(status_code=409, detail="同一消息标识不能复用不同正文") from exc
        raise HTTPException(status_code=409, detail="消息序号冲突，请重试") from exc
    logger.info(
        "[co-create-room] message saved room_id=%s project_id=%s user_id=%s seq=%s event_seq=%s turn_id=%s state=%s agent_mode=%s mentions=%s",
        room_id,
        project_id,
        user_id,
        seq,
        event_seq,
        turn_id,
        state,
        mode,
        ",".join(roles),
    )
    return message_to_dict(row)


def schedule_room_drain(background_tasks: BackgroundTasks, room_id: str) -> None:
    background_tasks.add_task(drain_project_room, room_id)


async def drain_project_room(room_id: str) -> None:
    async with _lock_for(room_id):
        async with async_session_maker() as db:
            await _drain_with_session(db, room_id)


async def drain_room(db: AsyncSession, room_id: str) -> None:
    """测试可传入已有会话；正式路径用 drain_project_room 自带会话。"""
    async with _lock_for(room_id):
        await _drain_with_session(db, room_id)


def _lease_deadline() -> str:
    return (datetime.now() + timedelta(seconds=_LEASE_SECONDS)).isoformat()


async def _drain_with_session(db: AsyncSession, room_id: str) -> None:
    while True:
        turn_id = await _claim_turn(db, room_id)
        if not turn_id:
            return
        try:
            await _execute_turn(db, room_id, turn_id)
        except Exception as exc:
            logger.exception("[co-create-room] turn failed room_id=%s turn_id=%s", room_id, turn_id)
            await db.rollback()
            db.expire_all()
            code = getattr(exc, "status_code", None)
            if isinstance(exc, FileActionConflict):
                code = 409
            await _mark_turn_failed(room_id, turn_id, str(exc), code if isinstance(code, int) else None)


async def _human_message(db: AsyncSession, room_id: str, turn_id: str) -> ProjectRoomMessage | None:
    return (
        await db.execute(
            select(ProjectRoomMessage).where(
                ProjectRoomMessage.room_id == room_id,
                ProjectRoomMessage.turn_id == turn_id,
                ProjectRoomMessage.author_type == "human",
            )
        )
    ).scalar_one_or_none()


async def _claim_turn(db: AsyncSession, room_id: str) -> str | None:
    db.expire_all()
    room = await db.get(ProjectRoom, room_id)
    if not room:
        return None
    if room.active_turn_id:
        human = await _human_message(db, room_id, room.active_turn_id)
        if human and human.turn_state not in _TERMINAL_TURN_STATES:
            human.turn_state = "running"
            room.lease_until = _lease_deadline()
            await db.commit()
            return room.active_turn_id
        room.active_turn_id = None
        room.lease_until = None
    queued = (
        await db.execute(
            select(ProjectRoomMessage)
            .where(
                ProjectRoomMessage.room_id == room_id,
                ProjectRoomMessage.author_type == "human",
                ProjectRoomMessage.turn_state == "queued",
            )
            .order_by(ProjectRoomMessage.seq.asc())
        )
    ).scalars().first()
    if not queued:
        await db.commit()
        return None
    room.active_turn_id = queued.turn_id
    room.lease_until = _lease_deadline()
    queued.turn_state = "running"
    await db.commit()
    return queued.turn_id


async def _turn_messages(db: AsyncSession, room_id: str, turn_id: str) -> list[ProjectRoomMessage]:
    return list(
        (
            await db.execute(
                select(ProjectRoomMessage)
                .where(ProjectRoomMessage.room_id == room_id, ProjectRoomMessage.turn_id == turn_id)
                .order_by(ProjectRoomMessage.seq.asc())
            )
        ).scalars().all()
    )


async def _recent_transcript(db: AsyncSession, room_id: str, before_seq: int) -> list[str]:
    rows = (
        await db.execute(
            select(ProjectRoomMessage)
            .where(ProjectRoomMessage.room_id == room_id, ProjectRoomMessage.seq < before_seq)
            .order_by(ProjectRoomMessage.seq.desc())
            .limit(30)
        )
    ).scalars().all()
    lines = []
    for row in reversed(list(rows)):
        lines.append(f"{row.author_name}: {row.content}")
    return lines


async def _mark_turn_failed(room_id: str, turn_id: str, summary: str, code: int | None) -> None:
    async with async_session_maker() as db:
        human = await _human_message(db, room_id, turn_id)
        room = await db.get(ProjectRoom, room_id)
        if human and human.turn_state not in {"succeeded", "cancelled"}:
            human.turn_state = "failed"
            human.error_summary = (summary or "回合失败")[:500]
            human.error_code = code
        if room and room.active_turn_id == turn_id:
            room.active_turn_id = None
            room.lease_until = None
            room.updated_at = _now()
        await db.commit()
        logger.info(
            "[co-create-room] turn failed persisted room_id=%s turn_id=%s code=%s",
            room_id,
            turn_id,
            code,
        )


async def _commit_turn(db: AsyncSession) -> None:
    if _turn_commit_hook is not None:
        await _turn_commit_hook()
    await db.commit()


def _target_from_materials(materials: list[dict[str, Any]], output_id: str | None) -> dict[str, Any]:
    for item in materials:
        if item.get("purpose") in {"target", "revise", "modify"}:
            return item
    if output_id:
        return {"file_id": output_id, "kind": "output", "purpose": "target", "version": "", "excerpt": ""}
    return {}


async def _open_run(db: AsyncSession, *, room: ProjectRoom, human: ProjectRoomMessage) -> str:
    from backend.services.run_log_service import create_run

    run_id = str(uuid.uuid4())
    await create_run(
        db,
        run_id=run_id,
        project_id=room.project_id,
        entrypoint="co_create_room",
        user_id=human.author_id,
        request_json=json.dumps(
            {"room_id": room.id, "turn_id": human.turn_id, "mode": human.agent_mode},
            ensure_ascii=False,
        ),
        snapshot_json=json.dumps({"writer_driver": writer_driver_name()}, ensure_ascii=False),
    )
    human.run_id = run_id
    await db.commit()
    logger.info(
        "[co-create-room] run opened room_id=%s turn_id=%s run_id=%s driver=%s",
        room.id,
        human.turn_id,
        run_id,
        writer_driver_name(),
    )
    return run_id


async def _finish_without_write(
    db: AsyncSession,
    *,
    room: ProjectRoom,
    human: ProjectRoomMessage,
    reason: str,
) -> None:
    human.turn_state = "succeeded"
    human.error_summary = ""
    human.error_code = None
    if room.active_turn_id == human.turn_id:
        room.active_turn_id = None
        room.lease_until = None
    room.updated_at = _now()
    await _commit_turn(db)
    logger.info(
        "[co-create-room] skip doc write room_id=%s project_id=%s user_id=%s turn_id=%s reason=%s",
        room.id,
        room.project_id,
        human.author_id,
        human.turn_id,
        reason,
    )


async def _execute_turn(db: AsyncSession, room_id: str, turn_id: str) -> None:
    room = await db.get(ProjectRoom, room_id)
    human = await _human_message(db, room_id, turn_id)
    if not room or not human:
        return
    if human.turn_state == "cancelled":
        room.active_turn_id = None
        room.lease_until = None
        await db.commit()
        return
    project = await db.get(Project, room.project_id)
    from backend.services.project_member_service import get_project_role

    author_role = await get_project_role(
        db,
        project_id=room.project_id,
        user_id=human.author_id,
        project=project,
    )
    can_write = bool(author_role and project_perm_allowed(author_role, "write"))
    archived = bool(room.archived_at) or bool(project and (project.status or "").lower() == "archived")
    materials = _loads(getattr(human, "materials_json", None), [])
    target = _target_from_materials(materials, room.output_id)
    base_version = ""
    if target.get("file_id"):
        current = await db.get(OutputAsset, str(target["file_id"]))
        if current and current.project_id == room.project_id:
            base_version = str(current.version or "1")
            target["version"] = base_version
            if not target.get("excerpt"):
                target["excerpt"] = current.content or ""
    allowed, reason = allows_file_write(
        mode=normalize_room_agent_mode(getattr(human, "agent_mode", None)),
        text=human.content or "",
        has_plan=bool(room.plan_id) and int(room.plan_version or 0) > 0,
        plan_version=int(room.plan_version or 0),
        confirm_plan_version=getattr(human, "plan_version", None),
        archived=archived,
    )
    if not can_write and allowed:
        allowed, reason = False, "forbidden"
    seated_ids = _loads(room.role_ids_json, [])
    mentioned = _loads(human.mention_role_ids_json, [])
    speakers = [rid for rid in speaker_role_ids(mentioned, room.writer_role_id or "") if rid in seated_ids]
    already = {
        row.author_id
        for row in await _turn_messages(db, room_id, turn_id)
        if row.author_type == "agent"
    }
    transcript = await _recent_transcript(db, room_id, human.seq)
    if not getattr(human, "run_id", None):
        await _open_run(db, room=room, human=human)
        room = await db.get(ProjectRoom, room_id)
        human = await _human_message(db, room_id, turn_id)
        if not room or not human:
            return
    discussion: list[tuple[str, str]] = []
    writer_reply = ""
    for existing in await _turn_messages(db, room_id, turn_id):
        if existing.author_type == "agent":
            discussion.append((existing.author_name, existing.content or ""))
            if existing.author_id == room.writer_role_id:
                writer_reply = existing.content or ""

    for rid in speakers:
        if rid in already:
            continue
        fresh = await _human_message(db, room_id, turn_id)
        if fresh and fresh.turn_state == "cancelled":
            room.active_turn_id = None
            room.lease_until = None
            await db.commit()
            return
        role = await _role_detail(rid)
        if role.get("missing"):
            continue
        prior = "\n".join(text for _, text in discussion if text)
        await db.commit()
        ctx = {
            "human_text": human.content,
            "prior_agent_text": prior,
            "transcript": transcript + [f"{name}: {text}" for name, text in discussion],
            "project_name": project.name if project else "",
            "project_background": (project.background or "") if project else "",
            "document": target.get("excerpt") or await _output_content(db, room.output_id),
            "materials": materials,
            "target": target,
            "allow_write": allowed,
            "write_reason": reason,
            "is_writer": rid == room.writer_role_id,
            "agent_mode": effective_room_mode(getattr(human, "agent_mode", None), human.content or ""),
            "system": role.get("system") or "",
            "run_id": human.run_id,
        }
        reply = (await complete_room_turn(role, ctx)).strip() or f"{role.get('name') or rid} 暂无补充。"
        room = await db.get(ProjectRoom, room_id)
        human = await _human_message(db, room_id, turn_id)
        if not room or not human:
            return
        seq = await _alloc_agent_seq(db, room_id, human.seq)
        event_seq = await _alloc_event_seq(db, room_id)
        now = _now()
        agent_row = ProjectRoomMessage(
            id=str(uuid.uuid4()),
            room_id=room_id,
            seq=seq,
            event_seq=event_seq,
            turn_id=turn_id,
            author_type="agent",
            author_id=rid,
            author_name=str(role.get("name") or rid),
            content=reply,
            mention_role_ids_json="[]",
            mention_user_ids_json="[]",
            mention_file_ids_json="[]",
            file_actions_json="[]",
            materials_json="[]",
            warnings_json="[]",
            turn_state="succeeded",
            run_id=human.run_id,
            created_at=now,
        )
        db.add(agent_row)
        room.updated_at = now
        await db.commit()
        discussion.append((agent_row.author_name, reply))
        if rid == room.writer_role_id:
            writer_reply = reply
        logger.info(
            "[co-create-room] agent reply room_id=%s project_id=%s role_id=%s seq=%s event_seq=%s turn_id=%s run_id=%s",
            room_id,
            room.project_id,
            rid,
            seq,
            event_seq,
            turn_id,
            human.run_id,
        )

    room = await db.get(ProjectRoom, room_id)
    human = await _human_message(db, room_id, turn_id)
    if not room or not human:
        return
    if human.agent_mode == "plan" and not is_plan_confirm(human.content or ""):
        summary = writer_reply or human.content or ""
        room.plan_version = int(room.plan_version or 0) + 1
        room.plan_id = room.plan_id or str(uuid.uuid4())
        room.plan_summary = summary[:2000]
        room.plan_confirmed_version = None
        room.plan_confirmed_by = None
        human.plan_id = room.plan_id
    if not allowed:
        await _finish_without_write(db, room=room, human=human, reason=reason)
        return

    proposal_id = f"room-{turn_id}"
    applied = (
        await db.execute(
            select(ProjectFileActionLog).where(
                ProjectFileActionLog.project_id == room.project_id,
                ProjectFileActionLog.proposal_id == proposal_id,
                ProjectFileActionLog.status == "applied",
            )
        )
    ).scalar_one_or_none()
    if applied and applied.result_file_id:
        room.output_id = applied.result_file_id
        human.turn_state = "succeeded"
        if room.active_turn_id == turn_id:
            room.active_turn_id = None
            room.lease_until = None
        if reason == "plan_confirmed":
            room.plan_confirmed_version = int(room.plan_version or 0)
            room.plan_confirmed_by = human.author_id
        await _commit_turn(db)
        logger.info(
            "[co-create-room] file action reused room_id=%s turn_id=%s proposal_id=%s",
            room_id,
            turn_id,
            proposal_id,
        )
        return

    document = delivery_document(room.title, writer_reply)
    target_id = str(target.get("file_id") or room.output_id or "")
    if target_id:
        action: dict[str, Any] = {
            "type": "patch",
            "file_id": target_id,
            "target_file_id": target_id,
            "file_kind": "output",
            "file_name": f"{room.title}.md",
            "edit_mode": "full",
            "content": document,
            "summary": "共创修订",
            "base_version": base_version or target.get("version") or None,
        }
    else:
        action = {
            "type": "create",
            "file_name": f"{room.title}.md",
            "path": f"/输出/{room.title}.md",
            "content": document,
            "summary": "共创创建",
        }
    try:
        result = await apply_file_action(
            db,
            room.project_id,
            effective_uid=human.author_id,
            action=action,
            session_id=None,
            message_id=human.id,
            proposal_id=proposal_id,
            commit=False,
        )
    except FileNameConflict:
        raise
    room.output_id = str(result.get("result_file_id") or room.output_id or "")
    room.doc_version = int(room.doc_version or 0) + 1
    room.updated_at = _now()
    if reason == "plan_confirmed":
        room.plan_confirmed_version = int(room.plan_version or 0)
        room.plan_confirmed_by = human.author_id
    human.turn_state = "succeeded"
    human.error_summary = ""
    human.error_code = None
    if room.active_turn_id == turn_id:
        room.active_turn_id = None
        room.lease_until = None
    last_agent = (
        await db.execute(
            select(ProjectRoomMessage)
            .where(
                ProjectRoomMessage.room_id == room_id,
                ProjectRoomMessage.turn_id == turn_id,
                ProjectRoomMessage.author_type == "agent",
            )
            .order_by(ProjectRoomMessage.seq.desc())
        )
    ).scalars().first()
    file_action = {
        "proposal_id": proposal_id,
        "type": action["type"],
        "file_id": room.output_id,
        "summary": action["summary"],
        "base_version": action.get("base_version"),
    }
    if last_agent:
        last_agent.file_actions_json = json.dumps([file_action], ensure_ascii=False)
    await _commit_turn(db)
    if result.get("defer_ingest") and room.output_id:
        schedule_ingest_output(str(room.output_id))
    logger.info(
        "[co-create-room] doc updated room_id=%s project_id=%s user_id=%s output_id=%s doc_version=%s run_id=%s reason=%s",
        room_id,
        room.project_id,
        human.author_id,
        room.output_id,
        room.doc_version,
        human.run_id,
        reason,
    )


async def assert_room_manual_write(
    db: AsyncSession,
    *,
    project_id: str,
    room_id: str,
    user_id: str,
) -> ProjectRoom:
    """手工保存走房间合同，不把 room_id 当成 ChatSession。"""
    project = await require_project_for_user(db, project_id, user_id, min_perm="write")
    room = await _require_room(db, project_id, room_id)
    if room.archived_at or (project.status or "").lower() == "archived":
        raise HTTPException(status_code=403, detail="归档后不能写入")
    logger.info(
        "[co-create-room] manual write allowed room_id=%s project_id=%s user_id=%s",
        room_id,
        project_id,
        user_id,
    )
    return room


async def cancel_room_turn(
    db: AsyncSession,
    *,
    project_id: str,
    room_id: str,
    turn_id: str,
    user_id: str,
) -> dict[str, Any]:
    await _project_role(db, project_id, user_id)
    room = await _require_room(db, project_id, room_id)
    human = await _human_message(db, room_id, turn_id)
    if not human:
        raise HTTPException(status_code=404, detail="回合不存在")
    if human.turn_state in _TERMINAL_TURN_STATES and human.turn_state != "done":
        return message_to_dict(human)
    human.turn_state = "cancelled"
    human.error_summary = "已取消"
    if room.active_turn_id == turn_id:
        room.active_turn_id = None
        room.lease_until = None
    room.updated_at = _now()
    await db.commit()
    logger.info("[co-create-room] turn cancelled room_id=%s turn_id=%s user_id=%s", room_id, turn_id, user_id)
    return message_to_dict(human)


async def retry_room_turn(
    db: AsyncSession,
    *,
    project_id: str,
    room_id: str,
    turn_id: str,
    user_id: str,
) -> dict[str, Any]:
    await require_project_for_user(db, project_id, user_id, min_perm="write")
    room = await _require_room(db, project_id, room_id)
    human = await _human_message(db, room_id, turn_id)
    if not human:
        raise HTTPException(status_code=404, detail="回合不存在")
    if human.turn_state != "failed":
        raise HTTPException(status_code=409, detail="只有失败回合可以重试")
    if int(room.turn_retry or 0) >= _MAX_TURN_RETRY:
        raise HTTPException(status_code=409, detail="重试次数已用完")
    room.turn_retry = int(room.turn_retry or 0) + 1
    human.turn_state = "queued" if room.active_turn_id else "running"
    human.error_summary = ""
    human.error_code = None
    if not room.active_turn_id:
        room.active_turn_id = turn_id
        room.lease_until = _lease_deadline()
    room.updated_at = _now()
    await db.commit()
    logger.info(
        "[co-create-room] turn retry room_id=%s turn_id=%s retry=%s",
        room_id,
        turn_id,
        room.turn_retry,
    )
    return message_to_dict(human)


async def recover_incomplete_turns() -> list[str]:
    """启动时领回过期回合。已成功的文件动作只对账，不重复落稿。"""
    recovered: list[str] = []
    async with async_session_maker() as db:
        rooms = (
            await db.execute(select(ProjectRoom).where(ProjectRoom.active_turn_id.is_not(None)))
        ).scalars().all()
        now = _now()
        for room in rooms:
            if room.lease_until and room.lease_until > now:
                continue
            turn_id = room.active_turn_id or ""
            human = await _human_message(db, room.id, turn_id)
            if not human:
                room.active_turn_id = None
                room.lease_until = None
                continue
            if human.turn_state in _TERMINAL_TURN_STATES:
                room.active_turn_id = None
                room.lease_until = None
                continue
            proposal_id = f"room-{turn_id}"
            applied = (
                await db.execute(
                    select(ProjectFileActionLog).where(
                        ProjectFileActionLog.project_id == room.project_id,
                        ProjectFileActionLog.proposal_id == proposal_id,
                        ProjectFileActionLog.status == "applied",
                    )
                )
            ).scalar_one_or_none()
            if applied and applied.result_file_id:
                room.output_id = room.output_id or applied.result_file_id
                human.turn_state = "succeeded"
                room.active_turn_id = None
                room.lease_until = None
                logger.info(
                    "[co-create-room] recover reused action room_id=%s turn_id=%s proposal_id=%s",
                    room.id,
                    turn_id,
                    proposal_id,
                )
                continue
            room.turn_retry = int(room.turn_retry or 0) + 1
            if room.turn_retry > _MAX_TURN_RETRY:
                human.turn_state = "failed"
                human.error_summary = "回合超时，已停止重试"
                room.active_turn_id = None
                room.lease_until = None
                logger.info("[co-create-room] recover gave up room_id=%s turn_id=%s", room.id, turn_id)
                continue
            human.turn_state = "queued"
            room.active_turn_id = None
            room.lease_until = None
            recovered.append(room.id)
            logger.info(
                "[co-create-room] recover requeue room_id=%s turn_id=%s retry=%s",
                room.id,
                turn_id,
                room.turn_retry,
            )
        await db.commit()
    for room_id in recovered:
        await drain_project_room(room_id)
    return recovered
