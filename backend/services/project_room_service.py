"""项目共创群聊：人话先落库，Agent 按房间串行回复，主笔收束右侧文档。"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from datetime import datetime
from typing import Any, Awaitable, Callable

from fastapi import BackgroundTasks, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import async_session_maker
from backend.models.output_asset import OutputAsset
from backend.models.project import Project
from backend.models.project_member import ProjectMember
from backend.models.project_room import ProjectRoom, ProjectRoomMessage
from backend.services.file_action_service import apply_file_action
from backend.services.multi_agent_resources import MultiAgentResourceError, get_role, list_roles
from backend.services.project_access import require_project_for_user
from backend.services.rbac import project_perm_allowed

logger = logging.getLogger("tpdx.hermes.co_create_room")

MENTION_RE = re.compile(r"@([^\s@]+)")
_AGENT_MODES = {"ask", "agent", "plan"}
_PLAN_CONFIRM_RE = re.compile(
    r"^(确认(执行|计划)?|开始执行|按计划执行|执行计划|继续执行|ok|go|yes)$",
    re.I,
)
RoomCompleter = Callable[[dict[str, Any], dict[str, Any]], Awaitable[str]]

_room_locks: dict[str, asyncio.Lock] = {}
_completer: RoomCompleter | None = None


def normalize_room_agent_mode(value: str | None) -> str:
    mode = (value or "agent").strip().lower()
    return mode if mode in _AGENT_MODES else "agent"


def room_turn_writes_document(mode: str, text: str) -> bool:
    """Ask 只读；Plan 先规划，确认后才写回；Agent 可写回。都不会新建文档。"""
    resolved = normalize_room_agent_mode(mode)
    if resolved == "ask":
        return False
    if resolved == "plan":
        return bool(_PLAN_CONFIRM_RE.match((text or "").strip()))
    return True


def set_room_completer_for_tests(fn: RoomCompleter | None) -> None:
    global _completer
    _completer = fn


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
        "created_at": row.created_at,
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
    lines = [f"### {human_text.strip()}"]
    for name, text in discussion:
        cleaned = (text or "").strip()
        if cleaned:
            lines.append(f"- {name}：{cleaned}")
    block = "\n".join(lines).strip() + "\n"
    if not (previous or "").strip():
        return f"# {title}\n\n{block}"
    return previous.rstrip() + "\n\n" + block


async def mock_room_reply(role: dict[str, Any], ctx: dict[str, Any]) -> str:
    name = str(role.get("name") or role.get("id") or "角色")
    human = str(ctx.get("human_text") or "")
    prior = str(ctx.get("prior_agent_text") or "")
    if ctx.get("is_writer"):
        line = f"主笔收束：{human}"
    else:
        line = f"{name}回应：{human}"
    if prior:
        line += f"\n承接：{prior}"
    transcript = ctx.get("transcript") or []
    if transcript:
        line += f"\n已看到：{transcript[-1]}"
    return line


async def complete_room_turn(role: dict[str, Any], ctx: dict[str, Any]) -> str:
    if _completer is not None:
        return await _completer(role, ctx)
    return await mock_room_reply(role, ctx)


async def _alloc_human_seq(db: AsyncSession, room_id: str) -> int:
    """每轮占用 1000 个序号。后入库的人话用下一轮的整段，上一轮 Agent 仍能插在它前面。"""
    current = await db.scalar(
        select(func.max(ProjectRoomMessage.seq)).where(ProjectRoomMessage.room_id == room_id)
    )
    turn_index = int(current or 0) // 1000 + 1
    return turn_index * 1000


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
) -> dict[str, Any]:
    await _project_role(db, project_id, user_id)
    room = await _require_room(db, project_id, room_id)
    rows = (
        await db.execute(
            select(ProjectRoomMessage)
            .where(ProjectRoomMessage.room_id == room_id, ProjectRoomMessage.seq > after_seq)
            .order_by(ProjectRoomMessage.seq.asc())
        )
    ).scalars().all()
    content = await _output_content(db, room.output_id)
    logger.info(
        "[co-create-room] list messages room_id=%s project_id=%s user_id=%s after=%s count=%s",
        room_id,
        project_id,
        user_id,
        after_seq,
        len(rows),
    )
    payload = room_to_dict(room, content=content)
    payload["messages"] = [message_to_dict(row) for row in rows]
    return payload


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
) -> dict[str, Any]:
    role = await _project_role(db, project_id, user_id)
    if not project_perm_allowed(role, "read"):
        raise HTTPException(status_code=404, detail="Project not found")
    text = (content or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="发言不能为空")
    room = await _require_room(db, project_id, room_id)
    seated_ids = _loads(room.role_ids_json, [])
    seated_roles = [await _role_detail(rid) for rid in seated_ids]
    members = await _member_ids(db, project_id)
    roles, users = resolve_mentions(
        text,
        roles=seated_roles,
        member_ids=members,
        explicit_role_ids=mention_role_ids,
        explicit_user_ids=mention_user_ids,
    )
    files = [str(item).strip() for item in (mention_file_ids or []) if str(item).strip()]
    mode = normalize_room_agent_mode(agent_mode)
    turn_id = str(uuid.uuid4())
    seq = await _alloc_human_seq(db, room_id)
    state = "queued" if room.active_turn_id else "running"
    if state == "running":
        room.active_turn_id = turn_id
    now = _now()
    row = ProjectRoomMessage(
        id=str(uuid.uuid4()),
        room_id=room_id,
        seq=seq,
        turn_id=turn_id,
        author_type="human",
        author_id=user_id,
        author_name=user_id,
        content=text,
        mention_role_ids_json=json.dumps(roles, ensure_ascii=False),
        mention_user_ids_json=json.dumps(users, ensure_ascii=False),
        mention_file_ids_json=json.dumps(files, ensure_ascii=False),
        file_actions_json="[]",
        agent_mode=mode,
        turn_state=state,
        created_at=now,
    )
    room.updated_at = now
    db.add(row)
    await db.commit()
    logger.info(
        "[co-create-room] message saved room_id=%s project_id=%s user_id=%s seq=%s turn_id=%s state=%s agent_mode=%s mentions=%s",
        room_id,
        project_id,
        user_id,
        seq,
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


async def _drain_with_session(db: AsyncSession, room_id: str) -> None:
    while True:
        turn_id = await _claim_turn(db, room_id)
        if not turn_id:
            return
        try:
            await _execute_turn(db, room_id, turn_id)
        except Exception:
            logger.exception("[co-create-room] turn failed room_id=%s turn_id=%s", room_id, turn_id)
        finally:
            room = await db.get(ProjectRoom, room_id)
            human = await _human_message(db, room_id, turn_id)
            if human and human.turn_state != "done":
                human.turn_state = "done"
            if room and room.active_turn_id == turn_id:
                room.active_turn_id = None
                room.updated_at = _now()
            await db.commit()


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
    room = await db.get(ProjectRoom, room_id)
    if not room:
        return None
    if room.active_turn_id:
        human = await _human_message(db, room_id, room.active_turn_id)
        if human and human.turn_state != "done":
            human.turn_state = "running"
            await db.commit()
            return room.active_turn_id
        room.active_turn_id = None
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


async def _file_names(db: AsyncSession, file_ids: list[str]) -> list[str]:
    names: list[str] = []
    for file_id in file_ids:
        row = await db.get(OutputAsset, file_id)
        if row and row.title:
            names.append(str(row.title))
    return names


async def _execute_turn(db: AsyncSession, room_id: str, turn_id: str) -> None:
    room = await db.get(ProjectRoom, room_id)
    human = await _human_message(db, room_id, turn_id)
    if not room or not human:
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
    seated_ids = _loads(room.role_ids_json, [])
    mentioned = _loads(human.mention_role_ids_json, [])
    speakers = [rid for rid in speaker_role_ids(mentioned, room.writer_role_id or "") if rid in seated_ids]
    already = {
        row.author_id
        for row in await _turn_messages(db, room_id, turn_id)
        if row.author_type == "agent"
    }
    transcript = await _recent_transcript(db, room_id, human.seq)
    file_names = await _file_names(db, _loads(human.mention_file_ids_json, []))
    discussion: list[tuple[str, str]] = []
    for existing in await _turn_messages(db, room_id, turn_id):
        if existing.author_type == "agent":
            discussion.append((existing.author_name, existing.content or ""))

    for rid in speakers:
        if rid in already:
            continue
        role = await _role_detail(rid)
        if role.get("missing"):
            continue
        prior = "\n".join(text for _, text in discussion if text)
        ctx = {
            "human_text": human.content,
            "prior_agent_text": prior,
            "transcript": transcript + [f"{name}: {text}" for name, text in discussion],
            "project_name": project.name if project else "",
            "project_background": (project.background or "") if project else "",
            "document": await _output_content(db, room.output_id),
            "file_names": file_names,
            "is_writer": rid == room.writer_role_id,
            "agent_mode": normalize_room_agent_mode(getattr(human, "agent_mode", None)),
            "system": role.get("system") or "",
        }
        reply = (await complete_room_turn(role, ctx)).strip() or f"{role.get('name') or rid} 暂无补充。"
        seq = await _alloc_agent_seq(db, room_id, human.seq)
        now = _now()
        agent_row = ProjectRoomMessage(
            id=str(uuid.uuid4()),
            room_id=room_id,
            seq=seq,
            turn_id=turn_id,
            author_type="agent",
            author_id=rid,
            author_name=str(role.get("name") or rid),
            content=reply,
            mention_role_ids_json="[]",
            mention_user_ids_json="[]",
            mention_file_ids_json="[]",
            file_actions_json="[]",
            turn_state="done",
            created_at=now,
        )
        db.add(agent_row)
        room.updated_at = now
        await db.commit()
        discussion.append((agent_row.author_name, reply))
        logger.info(
            "[co-create-room] agent reply room_id=%s project_id=%s role_id=%s seq=%s turn_id=%s",
            room_id,
            room.project_id,
            rid,
            seq,
            turn_id,
        )

    mode = normalize_room_agent_mode(getattr(human, "agent_mode", None))
    if not can_write or not room_turn_writes_document(mode, human.content or ""):
        logger.info(
            "[co-create-room] skip doc write room_id=%s project_id=%s user_id=%s turn_id=%s agent_mode=%s can_write=%s",
            room_id,
            room.project_id,
            human.author_id,
            turn_id,
            mode,
            can_write,
        )
        return

    room = await db.get(ProjectRoom, room_id)
    if not room:
        return
    if not room.output_id:
        logger.info(
            "[co-create-room] skip new doc room_id=%s project_id=%s user_id=%s turn_id=%s",
            room_id,
            room.project_id,
            human.author_id,
            turn_id,
        )
        return
    previous = await _output_content(db, room.output_id)
    document = compose_room_document(
        title=room.title,
        previous=previous,
        human_text=human.content,
        discussion=discussion,
    )
    proposal_id = f"room-{turn_id}"
    action = {
        "type": "patch",
        "file_id": room.output_id,
        "file_kind": "output",
        "file_name": f"{room.title}.md",
        "edit_mode": "full",
        "content": document,
        "summary": "共创修订",
    }
    result = await apply_file_action(
        db,
        room.project_id,
        effective_uid=human.author_id,
        action=action,
        session_id=room_id,
        message_id=human.id,
        proposal_id=proposal_id,
    )
    room = await db.get(ProjectRoom, room_id)
    if not room:
        return
    room.output_id = str(result.get("result_file_id") or room.output_id or "")
    room.doc_version = int(room.doc_version or 0) + 1
    room.updated_at = _now()
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
    }
    if last_agent:
        last_agent.file_actions_json = json.dumps([file_action], ensure_ascii=False)
    await db.commit()
    logger.info(
        "[co-create-room] doc updated room_id=%s project_id=%s user_id=%s output_id=%s doc_version=%s",
        room_id,
        room.project_id,
        human.author_id,
        room.output_id,
        room.doc_version,
    )
