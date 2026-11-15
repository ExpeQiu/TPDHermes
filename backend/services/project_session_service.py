"""项目 session 登记、回填，以及项目文件夹文件的增删改查。"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.chat_session import ChatSessionRecord
from backend.models.output_asset import OutputAsset
from backend.models.project_file_domain import ProjectFileActionLog
from backend.models.project_room import ProjectRoom
from backend.models.project_session import ProjectSession
from backend.services.project_access import require_project_for_user

logger = logging.getLogger("tpdx.hermes.project_sessions")

KINDS = frozenset({"dialogue", "scene", "cocreate", "brainstorm"})


def _now() -> str:
    return datetime.now().isoformat()


def scene_source_id(product: str, project_id: str) -> str:
    return f"{product}:{project_id}"


def session_dict(row: ProjectSession) -> dict[str, Any]:
    return {
        "id": row.id,
        "project_id": row.project_id,
        "kind": row.kind,
        "title": row.title,
        "source_kind": row.source_kind,
        "source_id": row.source_id,
        "owner_id": row.owner_id,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


async def ensure_project_session(
    db: AsyncSession,
    *,
    project_id: str,
    kind: str,
    source_id: str,
    source_kind: str,
    title: str,
    owner_id: str,
    commit: bool = True,
) -> ProjectSession:
    if kind not in KINDS:
        raise HTTPException(422, "session 类型必须是对话、场景、共创或头脑风暴")
    source = source_id.strip()
    if not source:
        raise HTTPException(422, "session 来源不能为空")
    row = (
        await db.execute(
            select(ProjectSession).where(
                ProjectSession.project_id == project_id,
                ProjectSession.kind == kind,
                ProjectSession.source_id == source,
            )
        )
    ).scalar_one_or_none()
    now = _now()
    if row is None:
        row = ProjectSession(
            id=str(uuid4()),
            project_id=project_id,
            kind=kind,
            title=(title or "").strip() or kind,
            source_kind=source_kind,
            source_id=source,
            owner_id=owner_id or "default",
            created_at=now,
            updated_at=now,
        )
        db.add(row)
        logger.info(
            "project session created project_id=%s kind=%s source_id=%s session_id=%s",
            project_id,
            kind,
            source,
            row.id,
        )
    else:
        next_title = (title or "").strip()
        if next_title:
            row.title = next_title
        row.updated_at = now
    if commit:
        await db.commit()
        await db.refresh(row)
    else:
        await db.flush()
    return row


async def backfill_project_sessions(db: AsyncSession, project_id: str) -> None:
    rooms = (
        await db.execute(select(ProjectRoom).where(ProjectRoom.project_id == project_id))
    ).scalars().all()
    for room in rooms:
        if room.archived_at:
            continue
        await ensure_project_session(
            db,
            project_id=project_id,
            kind="cocreate",
            source_id=room.id,
            source_kind="room",
            title=room.title or "共创",
            owner_id=room.created_by or "default",
            commit=False,
        )
    chats = (await db.execute(select(ChatSessionRecord))).scalars().all()
    for chat in chats:
        if (chat.session_kind or "") == "project_co_create":
            continue
        try:
            context = json.loads(chat.context_json or "{}")
        except json.JSONDecodeError:
            continue
        if not isinstance(context, dict):
            continue
        if str(context.get("selectedProjectId") or "").strip() != project_id:
            continue
        await ensure_project_session(
            db,
            project_id=project_id,
            kind="dialogue",
            source_id=chat.id,
            source_kind="chat",
            title=chat.title or "对话",
            owner_id=chat.user_id or "default",
            commit=False,
        )
    await db.commit()
    logger.info("project session backfill project_id=%s rooms=%s", project_id, len(rooms))


async def list_project_sessions(db: AsyncSession, project_id: str, user_id: str) -> list[dict[str, Any]]:
    await require_project_for_user(db, project_id, user_id, min_perm="read")
    await backfill_project_sessions(db, project_id)
    rows = (
        await db.execute(
            select(ProjectSession)
            .where(ProjectSession.project_id == project_id)
            .order_by(ProjectSession.updated_at.desc())
        )
    ).scalars().all()
    return [session_dict(row) for row in rows]


async def get_project_session(
    db: AsyncSession, project_id: str, session_id: str
) -> ProjectSession:
    row = (
        await db.execute(
            select(ProjectSession).where(
                ProjectSession.id == session_id,
                ProjectSession.project_id == project_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "session 不存在")
    return row


async def resolve_output_session_id(
    db: AsyncSession,
    *,
    project_id: str,
    owner_id: str,
    kind: str,
    source_id: str | None,
    source_kind: str,
    title: str,
) -> str | None:
    """把调用方传来的来源 ID 收成项目 session。已是项目 session 时直接使用。"""
    raw = (source_id or "").strip()
    if not raw:
        return None
    existing = (
        await db.execute(
            select(ProjectSession).where(
                ProjectSession.id == raw,
                ProjectSession.project_id == project_id,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing.id
    row = await ensure_project_session(
        db,
        project_id=project_id,
        kind=kind,
        source_id=raw,
        source_kind=source_kind,
        title=title,
        owner_id=owner_id,
        commit=False,
    )
    return row.id


async def record_cutpot_reference(
    db: AsyncSession,
    *,
    project_id: str,
    user_id: str,
    detail: dict[str, Any],
) -> None:
    """CutPot 工程包仍在本机目录。项目文件夹只保存可查询的引用。"""
    session = await ensure_project_session(
        db,
        project_id=project_id,
        kind="scene",
        source_id=scene_source_id("V17", project_id),
        source_kind="cutpot",
        title="CutPot 场景",
        owner_id=user_id or "default",
        commit=False,
    )
    pointer = detail.get("projectDir") or detail.get("dataDir") or detail.get("url") or ""
    content = f"CutPot 工程引用\nproject_id: {project_id}\npath: {pointer}\n"
    existing = (
        await db.execute(
            select(OutputAsset).where(
                OutputAsset.project_id == project_id,
                OutputAsset.session_id == session.id,
                OutputAsset.title == "CutPot 工程引用",
                OutputAsset.status != "archived",
            )
        )
    ).scalar_one_or_none()
    now = _now()
    if existing is None:
        db.add(
            OutputAsset(
                id=str(uuid4()),
                project_id=project_id,
                title="CutPot 工程引用",
                summary="CutPot 本机工程引用",
                content=content,
                content_format="text",
                version="1",
                status="draft",
                owner_id=user_id or "default",
                session_id=session.id,
                created_at=now,
                updated_at=now,
            )
        )
    else:
        existing.content = content
        existing.updated_at = now
    await db.commit()
    logger.info("cutpot reference project_id=%s session_id=%s", project_id, session.id)


async def attach_scene_scope(
    db: AsyncSession,
    *,
    project_id: str,
    product: str,
    user_id: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    """场景活工程按 scene session 分开。缺省 session 继承旧的项目级文件。"""
    body = dict(payload)
    if body.get("session_id"):
        body.setdefault("inherit_legacy", False)
        return body
    session = await ensure_project_session(
        db,
        project_id=project_id,
        kind="scene",
        source_id=scene_source_id(product, project_id),
        source_kind="studio",
        title=f"{product} 场景",
        owner_id=user_id or "default",
        commit=True,
    )
    body["session_id"] = session.id
    body["inherit_legacy"] = True
    return body


def _log_action(
    db: AsyncSession,
    *,
    project_id: str,
    session_id: str,
    user_id: str,
    action: str,
    target_file_id: str | None,
    result_file_id: str | None,
) -> None:
    db.add(
        ProjectFileActionLog(
            id=str(uuid4()),
            project_id=project_id,
            session_id=session_id,
            proposal_id=str(uuid4()),
            action_type=action,
            target_file_id=target_file_id,
            result_file_id=result_file_id,
            status="applied",
            created_by=user_id or "default",
            created_at=_now(),
        )
    )


async def mutate_project_folder_file(
    db: AsyncSession,
    *,
    project_id: str,
    user_id: str,
    session_id: str,
    action: str,
    file_id: str | None = None,
    title: str | None = None,
    content: str | None = None,
) -> dict[str, Any]:
    await require_project_for_user(db, project_id, user_id, min_perm="write")
    session = await get_project_session(db, project_id, session_id)
    now = _now()
    if action == "create":
        text = (content or "").strip()
        if not text:
            raise HTTPException(422, "正文不能为空")
        row = OutputAsset(
            id=str(uuid4()),
            project_id=project_id,
            title=(title or "").strip() or "未命名文件",
            summary=text[:280],
            content=text,
            content_format="markdown",
            version="1",
            status="draft",
            owner_id=user_id or "default",
            session_id=session.id,
            created_at=now,
            updated_at=now,
        )
        db.add(row)
        _log_action(
            db,
            project_id=project_id,
            session_id=session.id,
            user_id=user_id,
            action="create",
            target_file_id=None,
            result_file_id=row.id,
        )
    elif action in {"update", "archive"}:
        row = (
            await db.execute(
                select(OutputAsset).where(
                    OutputAsset.id == file_id,
                    OutputAsset.project_id == project_id,
                    OutputAsset.status != "archived",
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise HTTPException(404, "项目文件不存在")
        if action == "archive":
            row.status = "archived"
        else:
            if title is not None and title.strip():
                row.title = title.strip()
            if content is not None:
                row.content = content
                row.summary = content[:280]
        row.updated_at = now
        _log_action(
            db,
            project_id=project_id,
            session_id=session.id,
            user_id=user_id,
            action=action,
            target_file_id=row.id,
            result_file_id=row.id,
        )
    else:
        raise HTTPException(422, "文件操作只支持新增、修改和归档")
    await db.commit()
    await db.refresh(row)
    logger.info(
        "project folder %s project_id=%s file_id=%s actor_session=%s origin_session=%s",
        action,
        project_id,
        row.id,
        session.id,
        row.session_id,
    )
    return {
        "id": row.id,
        "kind": "output",
        "title": row.title,
        "content": row.content or "",
        "status": row.status,
        "session_id": row.session_id,
        "actor_session_id": session.id,
        "updated_at": row.updated_at,
    }
