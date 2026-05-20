"""
SQLite 轻量迁移：为既有 tphermes.db 补齐编排相关列与表。
在 create_all 之后执行；仅使用 PRAGMA + ALTER TABLE。
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Iterable
from uuid import uuid4

from sqlalchemy import text
from sqlalchemy.engine import Connection

from backend.data.builtin_scenarios import BUILTIN_SCENARIOS, BUILTIN_VERSION

logger = logging.getLogger("tpdx.hermes")


def _existing_columns(conn: Connection, table: str) -> set[str]:
    rows = conn.execute(text(f"PRAGMA table_info({table})")).fetchall()
    return {str(r[1]) for r in rows}


def _add_columns(conn: Connection, table: str, specs: Iterable[tuple[str, str]]) -> None:
    existing = _existing_columns(conn, table)
    for col, ddl in specs:
        if col in existing:
            continue
        sql = f"ALTER TABLE {table} ADD COLUMN {col} {ddl}"
        conn.execute(text(sql))
        logger.info("sqlite_migrate: %s", sql)


def run_sqlite_migrations(connection: Connection) -> None:
    """同步函数，供 async_engine.begin() 内 run_sync 调用。"""
    tables = connection.execute(
        text("SELECT name FROM sqlite_master WHERE type='table'")
    ).fetchall()
    names = {str(r[0]) for r in tables}

    if "projects" in names:
        _add_columns(
            connection,
            "projects",
            [
                ("domain_profile_id", "TEXT"),
                ("knowledge_policy_id", "TEXT"),
                ("default_template_id", "TEXT"),
                ("scenario_profile_id", "TEXT"),
                ("owner_id", "TEXT NOT NULL DEFAULT 'default'"),
            ],
        )

    if "templates" in names:
        _add_columns(
            connection,
            "templates",
            [
                ("schema_json", "TEXT"),
                ("format", "TEXT DEFAULT 'markdown'"),
                ("validation_rules", "TEXT"),
                ("status", "TEXT DEFAULT 'active'"),
            ],
        )

    if "skills" in names:
        _add_columns(
            connection,
            "skills",
            [
                ("owner_id", "TEXT NOT NULL DEFAULT ''"),
            ],
        )

    if "outputs" in names:
        _add_columns(
            connection,
            "outputs",
            [
                ("title", "TEXT"),
                ("summary", "TEXT"),
                ("content_format", "TEXT DEFAULT 'markdown'"),
                ("run_id", "TEXT"),
                ("version", "TEXT DEFAULT '1'"),
                ("citations_json", "TEXT"),
                ("scenario_id", "TEXT"),
                ("owner_id", "TEXT NOT NULL DEFAULT 'default'"),
            ],
        )

    if "orchestration_runs" not in names:
        connection.execute(
            text(
                """
                CREATE TABLE orchestration_runs (
                    id TEXT PRIMARY KEY,
                    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
                    entrypoint TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'running',
                    request_json TEXT,
                    snapshot_json TEXT,
                    response_metadata_json TEXT,
                    assistant_content TEXT,
                    validation_json TEXT,
                    skills_policy_json TEXT,
                    error_message TEXT,
                    duration_ms INTEGER,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
                """
            )
        )
        logger.info("sqlite_migrate: created table orchestration_runs")

    if "project_configs" not in names:
        connection.execute(
            text(
                """
                CREATE TABLE project_configs (
                    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
                    defaults_json TEXT NOT NULL DEFAULT '{}',
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
                """
            )
        )
        logger.info("sqlite_migrate: created table project_configs")

    if "orchestration_runs" in names:
        _add_columns(
            connection,
            "orchestration_runs",
            [
                ("scenario_id", "TEXT"),
                ("user_id", "TEXT NOT NULL DEFAULT 'default'"),
            ],
        )

    if "project_attachments" in names:
        _add_columns(
            connection,
            "project_attachments",
            [
                ("ingest_status", "TEXT DEFAULT 'pending'"),
                ("kb_collection", "TEXT"),
                ("kb_doc_id", "TEXT"),
                ("chunk_count", "INTEGER"),
                ("ingest_error", "TEXT"),
                ("ingested_at", "TEXT"),
            ],
        )

    if "outputs" in names:
        _add_columns(
            connection,
            "outputs",
            [
                ("kb_ingest_status", "TEXT"),
                ("kb_doc_id", "TEXT"),
                ("kb_chunk_count", "INTEGER"),
                ("kb_ingested_at", "TEXT"),
                ("kb_ingest_error", "TEXT"),
            ],
        )

    if "project_attachments" not in names:
        connection.execute(
            text(
                """
                CREATE TABLE project_attachments (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    original_filename TEXT NOT NULL,
                    content_type TEXT,
                    size_bytes INTEGER NOT NULL,
                    stored_path TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    ingest_status TEXT DEFAULT 'pending',
                    kb_collection TEXT,
                    kb_doc_id TEXT,
                    chunk_count INTEGER,
                    ingest_error TEXT,
                    ingested_at TEXT
                )
                """
            )
        )
        connection.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_project_attachments_project_id "
                "ON project_attachments (project_id)"
            )
        )
        logger.info("sqlite_migrate: created table project_attachments")

    if "kb_ingest_jobs" not in names:
        connection.execute(
            text(
                """
                CREATE TABLE kb_ingest_jobs (
                    id TEXT PRIMARY KEY,
                    source_type TEXT NOT NULL DEFAULT 'manifest',
                    collection TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'queued',
                    payload_json TEXT NOT NULL DEFAULT '{}',
                    result_json TEXT,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                    created_by TEXT
                )
                """
            )
        )
        logger.info("sqlite_migrate: created table kb_ingest_jobs")

    if "kb_source_files" not in names:
        connection.execute(
            text(
                """
                CREATE TABLE kb_source_files (
                    id TEXT PRIMARY KEY,
                    file_name TEXT NOT NULL,
                    stored_path TEXT NOT NULL,
                    checksum TEXT,
                    mime_type TEXT,
                    size INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
                """
            )
        )
        logger.info("sqlite_migrate: created table kb_source_files")

    if "kb_source_files" in names:
        _add_columns(
            connection,
            "kb_source_files",
            [
                ("doc_id_hint", "TEXT"),
            ],
        )

    if "projects" in names:
        connection.execute(
            text("CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects (owner_id)")
        )

    if "user_preferences" not in names:
        connection.execute(
            text(
                """
                CREATE TABLE user_preferences (
                    user_id TEXT PRIMARY KEY,
                    preferences_json TEXT NOT NULL DEFAULT '{}',
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                )
                """
            )
        )
        logger.info("sqlite_migrate: created table user_preferences")

    _seed_builtin_scenarios(connection)
    _backfill_project_scenario_bindings(connection)


def _seed_builtin_scenarios(connection: Connection) -> None:
    """写入内置场景；已存在 id 则跳过。"""
    now = datetime.now().isoformat()
    for row in BUILTIN_SCENARIOS:
        sid = str(row["id"])
        exists = connection.execute(
            text("SELECT 1 FROM scenario_profiles WHERE id = :id LIMIT 1"),
            {"id": sid},
        ).fetchone()
        if exists:
            continue
        connection.execute(
            text(
                """
                INSERT INTO scenario_profiles (
                  id, code, name, description, category, goal, conversation_mode,
                  domain_json, knowledge_policy_json, skills_policy_json, output_policy_json,
                  preset_instructions, opening_hint, version, status, created_by, created_at, updated_at
                ) VALUES (
                  :id, :code, :name, :description, :category, :goal, :conversation_mode,
                  :domain_json, :knowledge_policy_json, :skills_policy_json, :output_policy_json,
                  :preset_instructions, :opening_hint, :version, :status, NULL, :created_at, :updated_at
                )
                """
            ),
            {
                "id": sid,
                "code": str(row["code"]),
                "name": str(row["name"]),
                "description": row.get("description"),
                "category": row.get("category"),
                "goal": row.get("goal"),
                "conversation_mode": str(row.get("conversation_mode", "task_oriented")),
                "domain_json": json.dumps(row.get("domain_json") or {}, ensure_ascii=False),
                "knowledge_policy_json": json.dumps(row.get("knowledge_policy_json") or {}, ensure_ascii=False),
                "skills_policy_json": json.dumps(row.get("skills_policy_json") or {}, ensure_ascii=False),
                "output_policy_json": json.dumps(row.get("output_policy_json") or {}, ensure_ascii=False),
                "preset_instructions": row.get("preset_instructions"),
                "opening_hint": row.get("opening_hint"),
                "version": BUILTIN_VERSION,
                "status": "published",
                "created_at": now,
                "updated_at": now,
            },
        )
        logger.info("sqlite_migrate: seeded scenario_profiles id=%s", sid)


def _backfill_project_scenario_bindings(connection: Connection) -> None:
    """为既有项目补全与内置场景的绑定，避免工坊无可用场景。"""
    tables = connection.execute(
        text("SELECT name FROM sqlite_master WHERE type='table'")
    ).fetchall()
    if "project_scenarios" not in {str(r[0]) for r in tables}:
        return
    if "projects" not in {str(r[0]) for r in tables}:
        return

    projects = connection.execute(text("SELECT id FROM projects")).fetchall()
    now = datetime.now().isoformat()
    for (pid,) in projects:
        project_id = str(pid)
        for row in BUILTIN_SCENARIOS:
            sid = str(row["id"])
            dup = connection.execute(
                text(
                    """
                    SELECT 1 FROM project_scenarios
                    WHERE project_id = :pid AND scenario_id = :sid LIMIT 1
                    """
                ),
                {"pid": project_id, "sid": sid},
            ).fetchone()
            if dup:
                continue
            is_def = 1 if sid == "general" else 0
            connection.execute(
                text(
                    """
                    INSERT INTO project_scenarios (
                      id, project_id, scenario_id, scenario_version, is_default, enabled, created_at, updated_at
                    ) VALUES (:id, :pid, :sid, :ver, :is_def, 1, :ts, :ts)
                    """
                ),
                {
                    "id": str(uuid4()),
                    "pid": project_id,
                    "sid": sid,
                    "ver": BUILTIN_VERSION,
                    "is_def": is_def,
                    "ts": now,
                },
            )
            logger.info(
                "sqlite_migrate: bound project=%s scenario=%s default=%s",
                project_id,
                sid,
                is_def,
            )
