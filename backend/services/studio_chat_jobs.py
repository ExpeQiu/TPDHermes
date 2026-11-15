"""Durable V04 request receipts. A lost worker is never silently resubmitted."""

import asyncio
import hashlib
import json
import os
import sqlite3
import time
from contextlib import closing
from pathlib import Path
from typing import Any

from fastapi import HTTPException

_jobs: set[asyncio.Task[None]] = set()
_JOB_TTL_SECONDS = 600


def _db() -> sqlite3.Connection:
    directory = Path(
        os.getenv("TPCSTORE_APP_DATA") or Path.home() / ".tpcstore/tpdhermes-v04"
    )
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    conn = sqlite3.connect(directory / "chat-jobs.sqlite3")
    conn.row_factory = sqlite3.Row
    conn.execute(
        """CREATE TABLE IF NOT EXISTS jobs (
          scope TEXT NOT NULL, id TEXT NOT NULL, snapshot TEXT NOT NULL,
          phase TEXT NOT NULL, started REAL NOT NULL, result TEXT,
          PRIMARY KEY (scope, id)
        )"""
    )
    return conn


def scope_for(user_id: str, source: dict[str, str]) -> str:
    value = [user_id, source["project_id"], source["kind"], source["id"]]
    return hashlib.sha256(json.dumps(value).encode()).hexdigest()


def get_job(scope: str, request_id: str) -> dict[str, Any]:
    with closing(_db()) as conn, conn:
        row = conn.execute(
            "SELECT * FROM jobs WHERE scope=? AND id=?", (scope, request_id)
        ).fetchone()
    if not row:
        raise HTTPException(404, "工作台对话任务不存在")
    status = row["phase"]
    if status == "running" and time.time() - row["started"] > _JOB_TTL_SECONDS:
        status = "unknown"
    return {
        "id": request_id,
        "status": status,
        "result": json.loads(row["result"] or "null"),
    }


def _reserve(scope: str, request_id: str, snapshot: str) -> bool:
    with closing(_db()) as conn, conn:
        conn.execute("BEGIN IMMEDIATE")
        existing = conn.execute(
            "SELECT snapshot FROM jobs WHERE scope=? AND id=?", (scope, request_id)
        ).fetchone()
        if existing:
            if existing["snapshot"] != snapshot:
                raise HTTPException(409, "同一任务编号不能提交不同指令或资料版本")
            return False
        conn.execute(
            "INSERT INTO jobs VALUES (?, ?, ?, 'running', ?, NULL)",
            (scope, request_id, snapshot, time.time()),
        )
        return True


def _finish(scope: str, request_id: str, status: str, result: dict[str, Any]) -> None:
    with closing(_db()) as conn, conn:
        conn.execute(
            "UPDATE jobs SET phase=?, result=? WHERE scope=? AND id=?",
            (status, json.dumps(result, ensure_ascii=False), scope, request_id),
        )


async def submit_job(
    scope: str, request_id: str, message: str, source: dict[str, str]
) -> dict[str, Any]:
    snapshot = hashlib.sha256(
        json.dumps([message, source["sha256"]]).encode()
    ).hexdigest()
    if await asyncio.to_thread(_reserve, scope, request_id, snapshot):
        task = asyncio.create_task(_run(scope, request_id, message, source))
        _jobs.add(task)
        task.add_done_callback(_jobs.discard)
    return await asyncio.to_thread(get_job, scope, request_id)


async def _run(
    scope: str, request_id: str, message: str, source: dict[str, str]
) -> None:
    from backend.routes.studio import execute_workbench_chat

    try:
        result = await execute_workbench_chat(
            message, source, f"{scope[:24]}-{request_id}"
        )
        status = "unknown" if result.get("result_unknown") else "completed"
    except HTTPException as exc:
        status = "unknown" if exc.status_code == 504 else "failed"
        result = {"reply": str(exc.detail), "http_status": exc.status_code}
    except Exception:
        status = "failed"
        result = {"reply": "工作台任务执行失败"}
    await asyncio.to_thread(_finish, scope, request_id, status, result)
