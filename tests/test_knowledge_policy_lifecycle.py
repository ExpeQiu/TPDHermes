import uuid

import pytest

from backend.db import async_session_maker
from backend.models.project import Project
from backend.services.knowledge_policy import validate_harvest_collection
from backend.services.knowledge_policy_store import (
    create_policy,
    get_policy,
    list_policy_versions,
    transition_policy_status,
    update_policy,
)


@pytest.mark.asyncio
async def test_knowledge_policy_lifecycle_and_versions():
    code = f"kp-{uuid.uuid4().hex[:8]}"
    async with async_session_maker() as db:
        row = await create_policy(
            db,
            code=code,
            name="测试策略",
            description="desc",
            config={"mode": "restricted", "write_control": {"allowed_collections": ["public.a"]}},
            actor="tester",
        )
        await db.commit()
        await db.refresh(row)

        await update_policy(
            db,
            row,
            name="测试策略2",
            description="desc2",
            config={"mode": "restricted", "write_control": {"allowed_collections": ["public.a"]}},
            actor="tester",
            change_note="rename",
        )
        await transition_policy_status(
            db,
            row,
            target_status="pending_approval",
            actor="reviewer",
        )
        await transition_policy_status(
            db,
            row,
            target_status="approved",
            actor="reviewer",
        )
        await transition_policy_status(
            db,
            row,
            target_status="published",
            actor="publisher",
        )
        await transition_policy_status(
            db,
            row,
            target_status="offline",
            actor="publisher",
        )
        await db.commit()

        latest = await get_policy(db, row.id)
        versions = await list_policy_versions(db, row.id)

    assert latest is not None
    assert latest.status == "offline"
    assert latest.version == "0.0.6"
    assert len(versions) == 6
    assert versions[0].status == "offline"


@pytest.mark.asyncio
async def test_validate_harvest_collection_uses_project_policy_entity():
    code = f"kp-{uuid.uuid4().hex[:8]}"
    async with async_session_maker() as db:
        row = await create_policy(
            db,
            code=code,
            name="项目写入策略",
            description=None,
            config={
                "mode": "restricted",
                "collections": ["public.allowed"],
                "write_control": {"allowed_collections": ["public.allowed"]},
            },
            actor="tester",
        )
        await transition_policy_status(
            db,
            row,
            target_status="pending_approval",
            actor="reviewer",
        )
        await transition_policy_status(
            db,
            row,
            target_status="approved",
            actor="reviewer",
        )
        project = Project(
            id=f"proj-{uuid.uuid4().hex[:8]}",
            name="policy-project",
            knowledge_policy_id=row.id,
            owner_id="tester",
        )
        db.add(project)
        await db.commit()

    ok, _, allowed = await validate_harvest_collection(
        "public.allowed",
        project_id=project.id,
        scenario_id=None,
    )
    assert ok is True
    assert allowed == ["public.allowed"]

    denied, err, denied_allowed = await validate_harvest_collection(
        "public.denied",
        project_id=project.id,
        scenario_id=None,
    )
    assert denied is False
    assert err == "collection_not_allowed"
    assert denied_allowed == ["public.allowed"]
