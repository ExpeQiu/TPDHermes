"""内置场景删除抑制：记录用户主动删除的内置 id，migration 不再重新 seed。"""

from __future__ import annotations

import logging
from datetime import datetime

from sqlalchemy import text
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import AsyncSession

from backend.data.builtin_scenarios import BUILTIN_SCENARIOS

logger = logging.getLogger("tpdx.hermes")

TABLE = "scenario_seed_suppressions"
BUILTIN_SCENARIO_IDS = frozenset(str(row["id"]) for row in BUILTIN_SCENARIOS)


def is_builtin_scenario_id(scenario_id: str) -> bool:
    return str(scenario_id) in BUILTIN_SCENARIO_IDS


def ensure_suppression_table(connection: Connection) -> None:
    connection.execute(
        text(
            f"""
            CREATE TABLE IF NOT EXISTS {TABLE} (
                scenario_id TEXT PRIMARY KEY,
                suppressed_at TEXT NOT NULL
            )
            """
        )
    )


def load_suppressed_ids_sync(connection: Connection) -> set[str]:
    ensure_suppression_table(connection)
    rows = connection.execute(text(f"SELECT scenario_id FROM {TABLE}")).fetchall()
    return {str(r[0]) for r in rows}


def suppress_builtin_sync(connection: Connection, scenario_id: str) -> None:
    sid = str(scenario_id)
    if not is_builtin_scenario_id(sid):
        return
    ensure_suppression_table(connection)
    connection.execute(
        text(
            f"""
            INSERT OR IGNORE INTO {TABLE} (scenario_id, suppressed_at)
            VALUES (:sid, :ts)
            """
        ),
        {"sid": sid, "ts": datetime.now().isoformat()},
    )
    logger.info("scenario seed suppressed id=%s", sid)


async def suppress_builtin_async(db: AsyncSession, scenario_id: str) -> None:
    sid = str(scenario_id)
    if not is_builtin_scenario_id(sid):
        return
    await db.execute(
        text(
            f"""
            CREATE TABLE IF NOT EXISTS {TABLE} (
                scenario_id TEXT PRIMARY KEY,
                suppressed_at TEXT NOT NULL
            )
            """
        )
    )
    await db.execute(
        text(
            f"""
            INSERT OR IGNORE INTO {TABLE} (scenario_id, suppressed_at)
            VALUES (:sid, :ts)
            """
        ),
        {"sid": sid, "ts": datetime.now().isoformat()},
    )
    logger.info("scenario seed suppressed id=%s", sid)
