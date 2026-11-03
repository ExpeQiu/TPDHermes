"""静默窗口：有人正在说话时不复盘。"""

from __future__ import annotations

import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta

import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from backend.models.chat_session import ChatMessageRecord, ChatSessionRecord
from backend.models.orchestration_run import OrchestrationRun
from backend.models.project import Project
from backend.models.project_room import ProjectRoom, ProjectRoomMessage
from backend.services.system_quiet import system_is_quiet


@asynccontextmanager
async def _quiet_db():
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    tables = (
        Project.__table__,
        ChatSessionRecord.__table__,
        ChatMessageRecord.__table__,
        OrchestrationRun.__table__,
        ProjectRoom.__table__,
        ProjectRoomMessage.__table__,
    )
    async with engine.begin() as conn:
        for table in tables:
            await conn.run_sync(lambda sync_conn, table=table: table.create(sync_conn))
    maker = async_sessionmaker(engine, expire_on_commit=False)
    try:
        yield maker
    finally:
        await engine.dispose()


def _ago(seconds: int) -> str:
    return (datetime.now() - timedelta(seconds=seconds)).isoformat()


@pytest.mark.asyncio
async def test_recent_chat_blocks_review():
    async with _quiet_db() as maker:
        async with maker() as db:
            session_id = str(uuid.uuid4())
            db.add(ChatSessionRecord(id=session_id, user_id="u", title="t", created_at_ms=1))
            db.add(
                ChatMessageRecord(
                    id=str(uuid.uuid4()),
                    session_id=session_id,
                    role="user",
                    content="还在说",
                    created_at=datetime.now().isoformat(),
                )
            )
            await db.commit()
            quiet, reason = await system_is_quiet(db, idle_seconds_value=600)
            assert quiet is False
            assert reason == "chat"


@pytest.mark.asyncio
async def test_old_activity_is_quiet():
    async with _quiet_db() as maker:
        async with maker() as db:
            session_id = str(uuid.uuid4())
            db.add(ChatSessionRecord(id=session_id, user_id="u", title="t", created_at_ms=1))
            db.add(
                ChatMessageRecord(
                    id=str(uuid.uuid4()),
                    session_id=session_id,
                    role="user",
                    content="早就说完了",
                    created_at=_ago(3600),
                )
            )
            db.add(
                OrchestrationRun(
                    id=str(uuid.uuid4()),
                    entrypoint="chat",
                    status="running",
                    updated_at=_ago(3600),
                    created_at=_ago(3600),
                )
            )
            await db.commit()
            quiet, reason = await system_is_quiet(db, idle_seconds_value=600)
            assert quiet is True
            assert reason == "idle"


@pytest.mark.asyncio
async def test_live_run_blocks_review():
    async with _quiet_db() as maker:
        async with maker() as db:
            db.add(
                OrchestrationRun(
                    id=str(uuid.uuid4()),
                    entrypoint="chat",
                    status="running",
                    updated_at=datetime.now().isoformat(),
                    created_at=datetime.now().isoformat(),
                )
            )
            await db.commit()
            quiet, reason = await system_is_quiet(db, idle_seconds_value=600)
            assert quiet is False
            assert reason == "run"


@pytest.mark.asyncio
async def test_live_room_turn_blocks_review():
    async with _quiet_db() as maker:
        async with maker() as db:
            db.add(
                ProjectRoom(
                    id="room-1",
                    project_id="p1",
                    title="共创",
                    created_by="u",
                    active_turn_id="turn-1",
                    updated_at=datetime.now().isoformat(),
                )
            )
            await db.commit()
            quiet, reason = await system_is_quiet(db, idle_seconds_value=600)
            assert quiet is False
            assert reason == "room_turn"
