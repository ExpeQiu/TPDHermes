from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.knowledge_policy import KnowledgePolicy
from backend.models.knowledge_policy_version import KnowledgePolicyVersion
from backend.services.skill_version import bump_version

POLICY_STATUS_FLOW: dict[str, set[str]] = {
    "draft": {"pending_approval", "offline"},
    "pending_approval": {"approved", "rejected", "draft"},
    "approved": {"published", "draft", "offline"},
    "published": {"offline"},
    "offline": {"draft", "pending_approval"},
    "rejected": {"draft", "pending_approval"},
}


def loads_json_dict(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def normalize_policy_config(config: dict[str, Any] | None) -> dict[str, Any]:
    data = dict(config or {})
    write_control = data.get("write_control")
    if not isinstance(write_control, dict):
        write_control = {}
    allowed = write_control.get("allowed_collections")
    if isinstance(allowed, list):
        write_control["allowed_collections"] = [
            str(x).strip() for x in allowed if str(x).strip()
        ]
    data["write_control"] = write_control
    return data


def policy_to_dict(row: KnowledgePolicy) -> dict[str, Any]:
    return {
        "id": row.id,
        "code": row.code,
        "name": row.name,
        "description": row.description,
        "config": loads_json_dict(row.config_json),
        "version": row.version,
        "status": row.status,
        "created_by": row.created_by,
        "approved_by": row.approved_by,
        "published_by": row.published_by,
        "offlined_by": row.offlined_by,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
        "approved_at": row.approved_at,
        "published_at": row.published_at,
        "offlined_at": row.offlined_at,
    }


async def get_policy(db: AsyncSession, policy_id: str) -> KnowledgePolicy | None:
    return await db.get(KnowledgePolicy, policy_id)


async def get_policy_by_code(db: AsyncSession, code: str) -> KnowledgePolicy | None:
    res = await db.execute(select(KnowledgePolicy).where(KnowledgePolicy.code == code))
    return res.scalar_one_or_none()


async def list_policies(db: AsyncSession, *, status: str | None = None) -> list[KnowledgePolicy]:
    query = select(KnowledgePolicy).order_by(KnowledgePolicy.updated_at.desc())
    if status:
        query = query.where(KnowledgePolicy.status == status)
    res = await db.execute(query)
    return list(res.scalars().all())


async def list_policy_versions(db: AsyncSession, policy_id: str) -> list[KnowledgePolicyVersion]:
    res = await db.execute(
        select(KnowledgePolicyVersion)
        .where(KnowledgePolicyVersion.policy_id == policy_id)
        .order_by(KnowledgePolicyVersion.created_at.desc())
    )
    return list(res.scalars().all())


async def _append_policy_version(
    db: AsyncSession,
    row: KnowledgePolicy,
    *,
    actor: str | None,
    change_note: str | None,
) -> None:
    snapshot = policy_to_dict(row)
    db.add(
        KnowledgePolicyVersion(
            policy_id=row.id,
            version=row.version,
            status=row.status,
            snapshot_json=json.dumps(snapshot, ensure_ascii=False),
            change_note=change_note,
            created_by=actor,
            created_at=datetime.now().isoformat(),
        )
    )


async def create_policy(
    db: AsyncSession,
    *,
    code: str,
    name: str,
    description: str | None,
    config: dict[str, Any] | None,
    actor: str | None,
    change_note: str | None = "initial_create",
) -> KnowledgePolicy:
    row = KnowledgePolicy(
        code=code.strip(),
        name=name.strip(),
        description=description,
        config_json=json.dumps(normalize_policy_config(config), ensure_ascii=False),
        version="0.0.1",
        status="draft",
        created_by=actor,
        created_at=datetime.now().isoformat(),
        updated_at=datetime.now().isoformat(),
    )
    db.add(row)
    await db.flush()
    await _append_policy_version(db, row, actor=actor, change_note=change_note)
    return row


async def update_policy(
    db: AsyncSession,
    row: KnowledgePolicy,
    *,
    name: str | None,
    description: str | None,
    config: dict[str, Any] | None,
    actor: str | None,
    change_note: str | None = None,
) -> KnowledgePolicy:
    if name is not None:
        row.name = name.strip()
    if description is not None:
        row.description = description
    if config is not None:
        row.config_json = json.dumps(normalize_policy_config(config), ensure_ascii=False)
    row.version = bump_version(row.version, level="patch")
    row.updated_at = datetime.now().isoformat()
    await _append_policy_version(
        db,
        row,
        actor=actor,
        change_note=change_note or "config_updated",
    )
    return row


async def transition_policy_status(
    db: AsyncSession,
    row: KnowledgePolicy,
    *,
    target_status: str,
    actor: str | None,
    change_note: str | None = None,
) -> KnowledgePolicy:
    allowed = POLICY_STATUS_FLOW.get(row.status, set())
    if target_status not in allowed:
        raise ValueError(f"invalid_status_transition:{row.status}->{target_status}")
    row.status = target_status
    row.version = bump_version(row.version, level="patch")
    now = datetime.now().isoformat()
    row.updated_at = now
    if target_status == "approved":
        row.approved_by = actor
        row.approved_at = now
    elif target_status == "published":
        row.published_by = actor
        row.published_at = now
    elif target_status == "offline":
        row.offlined_by = actor
        row.offlined_at = now
    await _append_policy_version(
        db,
        row,
        actor=actor,
        change_note=change_note or f"status->{target_status}",
    )
    return row
