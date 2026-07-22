"""项目默认场景绑定。"""
from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.data.builtin_scenarios import BUILTIN_SCENARIOS, BUILTIN_VERSION
from backend.models.project_scenario import ProjectScenario
from backend.models.scenario_profile import ScenarioProfile


async def seed_default_scenario_bindings(db: AsyncSession, project_id: str) -> None:
    """新项目自动绑定已存在的内置场景，保证工坊可用。"""
    now = datetime.now().isoformat()
    for row in BUILTIN_SCENARIOS:
        sid = str(row["id"])
        pro = await db.get(ScenarioProfile, sid)
        if not pro:
            continue
        dup = await db.execute(
            select(ProjectScenario).where(
                ProjectScenario.project_id == project_id,
                ProjectScenario.scenario_id == sid,
            )
        )
        if dup.scalar_one_or_none():
            continue
        ver = pro.version if pro.version else BUILTIN_VERSION
        db.add(
            ProjectScenario(
                id=str(uuid.uuid4()),
                project_id=project_id,
                scenario_id=sid,
                scenario_version=ver,
                is_default=1 if sid == "general" else 0,
                enabled=1,
                created_at=now,
                updated_at=now,
            )
        )
