"""启动时补齐技术推广预设数字员工。已有同名员工保持原样。"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.data.builtin_employees import builtin_employee_specs
from backend.models.digital_employee import DigitalEmployee, EmployeeResourceBinding
from backend.models.local_account import LocalAccount
from backend.services.user_identity import GLOBAL_ADMIN_ENV, normalize_user_id

logger = logging.getLogger("tpdx.hermes.employees")


def _owner_user_id() -> str:
    raw = os.getenv(GLOBAL_ADMIN_ENV, "")
    for item in raw.split(","):
        cleaned = item.strip()
        if cleaned:
            return normalize_user_id(cleaned)
    return "default"


async def _owner_name(db: AsyncSession, user_id: str) -> str:
    row = (
        await db.execute(select(LocalAccount).where(LocalAccount.user_id == user_id))
    ).scalar_one_or_none()
    if row is not None and (row.display_name or "").strip():
        return row.display_name.strip()
    return user_id


async def ensure_builtin_employees(db: AsyncSession) -> dict[str, int]:
    owner_id = _owner_user_id()
    owner_name = await _owner_name(db, owner_id)
    created = 0
    existing = 0
    today = datetime.now().date().isoformat()
    for spec in builtin_employee_specs():
        name = spec["name"]
        found = (
            await db.execute(select(DigitalEmployee).where(DigitalEmployee.name == name))
        ).scalar_one_or_none()
        if found is not None:
            existing += 1
            logger.info(
                "builtin employee exists name=%s id=%s scenario=%s",
                name,
                found.id,
                found.scenario_id,
            )
            continue
        row = DigitalEmployee(
            name=name,
            role_name=spec["role_name"],
            description=spec["description"],
            persona_prompt=spec["persona_prompt"],
            onboarded_at=today,
            work_styles_json=json.dumps(spec["work_styles"], ensure_ascii=False),
            expertise_json=json.dumps(spec["expertise"], ensure_ascii=False),
            work_modes_json=json.dumps(spec["work_modes"], ensure_ascii=False),
            status="active",
            published_to_gallery=1,
            owner_user_id=owner_id,
            owner_name=owner_name,
            scenario_id=spec["scenario_id"],
            scenario_version=spec["scenario_version"],
            pack_id=spec["pack_id"],
        )
        db.add(row)
        await db.flush()
        db.add(
            EmployeeResourceBinding(
                employee_id=row.id,
                resource_type="scenario",
                resource_id=spec["scenario_id"],
                resource_version=spec["scenario_version"],
                status="active",
            )
        )
        for skill in spec["skills"]:
            db.add(
                EmployeeResourceBinding(
                    employee_id=row.id,
                    resource_type="skill",
                    resource_id=skill,
                    resource_version="",
                    status="active",
                )
            )
        created += 1
        logger.info(
            "builtin employee seeded name=%s id=%s scenario=%s skills=%s owner=%s",
            name,
            row.id,
            spec["scenario_id"],
            len(spec["skills"]),
            owner_id,
        )
    await db.commit()
    logger.info(
        "builtin employees ready created=%s existing=%s owner=%s",
        created,
        existing,
        owner_id,
    )
    return {"created": created, "existing": existing}
