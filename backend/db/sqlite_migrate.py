"""
SQLite 轻量迁移：为既有 tphermes.db 补齐编排相关列与表。
在 create_all 之后执行；仅使用 PRAGMA + ALTER TABLE。
"""

from __future__ import annotations

import logging
from typing import Iterable

from sqlalchemy import text
from sqlalchemy.engine import Connection

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
