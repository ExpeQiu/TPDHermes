"""消息同步并发主键冲突，以及运行记录 refresh 丢失后的补救。"""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path

from sqlalchemy import delete, event
from sqlalchemy.exc import InvalidRequestError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from backend.db import Base, sqlite_uses_static_pool
from backend.models.chat_session import ChatMessageRecord
from backend.models.orchestration_run import OrchestrationRun
from backend.services.chat_session_service import (
    get_session_detail_for_user,
    sync_session_messages_for_user,
    upsert_session_for_user,
)
from backend.services.run_log_service import create_run, pop_issued_execution_token


def test_sqlite_file_does_not_use_static_pool():
    assert sqlite_uses_static_pool("sqlite+aiosqlite:///./tphermes.db") is False
    assert sqlite_uses_static_pool("sqlite+aiosqlite:///:memory:") is True
    assert sqlite_uses_static_pool("sqlite+aiosqlite:///file.db?mode=memory") is True


def _engine(path: Path):
    engine = create_async_engine(
        f"sqlite+aiosqlite:///{path}",
        connect_args={"check_same_thread": False},
        poolclass=NullPool,
    )

    @event.listens_for(engine.sync_engine, "connect")
    def _on_connect(dbapi_conn, _record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA busy_timeout=15000")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.close()

    return engine


def test_concurrent_message_sync_same_id(tmp_path: Path):
    async def _run() -> None:
        engine = _engine(tmp_path / "sync.db")
        maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        user_id = f"sync_{uuid.uuid4().hex[:8]}"
        session_id = f"sess_{uuid.uuid4().hex[:8]}"
        message_id = f"msg_{uuid.uuid4().hex[:8]}"
        try:
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
            async with maker() as db:
                await upsert_session_for_user(
                    db,
                    session_id=session_id,
                    user_id=user_id,
                    payload={"id": session_id, "title": "并发", "messages": []},
                )

            async def sync_one(content: str) -> None:
                async with maker() as db:
                    result = await sync_session_messages_for_user(
                        db,
                        session_id=session_id,
                        user_id=user_id,
                        messages=[
                            {
                                "id": message_id,
                                "role": "assistant",
                                "content": content,
                                "runId": "run-concurrent",
                            }
                        ],
                    )
                    assert result is not None

            await asyncio.gather(sync_one("甲"), sync_one("乙"))
            async with maker() as db:
                detail = await get_session_detail_for_user(
                    db, session_id=session_id, user_id=user_id
                )
            assert detail is not None
            messages = detail["messages"]
            assert len(messages) == 1
            assert messages[0]["id"] == message_id
            assert messages[0]["content"] in {"甲", "乙"}
            assert messages[0]["runId"] == "run-concurrent"
        finally:
            await engine.dispose()

    asyncio.run(_run())


def test_create_run_reloads_when_refresh_misses(tmp_path: Path):
    async def _run() -> None:
        engine = _engine(tmp_path / "runs.db")
        maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        run_id = str(uuid.uuid4())
        original = AsyncSession.refresh
        calls = {"n": 0}

        async def flaky(self, instance, attribute_names=None, with_for_update=None):
            if isinstance(instance, OrchestrationRun):
                calls["n"] += 1
                if calls["n"] == 1:
                    raise InvalidRequestError("Could not refresh instance")
            return await original(
                self,
                instance,
                attribute_names=attribute_names,
                with_for_update=with_for_update,
            )

        AsyncSession.refresh = flaky
        try:
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
            async with maker() as db:
                row = await create_run(
                    db,
                    run_id=run_id,
                    project_id=None,
                    entrypoint="chat",
                    user_id="default",
                    request_json="{}",
                    snapshot_json="{}",
                )
                assert row.id == run_id
                assert row.status == "running"
            assert pop_issued_execution_token(run_id)
            async with maker() as db:
                stored = await db.get(OrchestrationRun, run_id)
                assert stored is not None
                assert stored.entrypoint == "chat"
        finally:
            AsyncSession.refresh = original
            await engine.dispose()

    asyncio.run(_run())


def test_create_run_reinserts_when_row_disappears(tmp_path: Path):
    async def _run() -> None:
        engine = _engine(tmp_path / "runs-retry.db")
        maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        run_id = str(uuid.uuid4())
        original = AsyncSession.refresh
        calls = {"n": 0}

        async def flaky(self, instance, attribute_names=None, with_for_update=None):
            if isinstance(instance, OrchestrationRun):
                calls["n"] += 1
                if calls["n"] == 1:
                    await self.execute(delete(OrchestrationRun).where(OrchestrationRun.id == instance.id))
                    await self.commit()
                    raise InvalidRequestError("Could not refresh instance")
            return await original(
                self,
                instance,
                attribute_names=attribute_names,
                with_for_update=with_for_update,
            )

        AsyncSession.refresh = flaky
        try:
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)
            async with maker() as db:
                row = await create_run(
                    db,
                    run_id=run_id,
                    project_id=None,
                    entrypoint="chat",
                    user_id="default",
                    request_json="{}",
                    snapshot_json="{}",
                )
                assert row.id == run_id
            assert calls["n"] >= 2
            async with maker() as db:
                stored = await db.get(OrchestrationRun, run_id)
                assert stored is not None
                assert stored.status == "running"
        finally:
            AsyncSession.refresh = original
            await engine.dispose()

    asyncio.run(_run())
