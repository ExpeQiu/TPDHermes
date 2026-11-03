"""工作区技能登记、空市场、共创兜底与对话用量。"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from backend import app
from backend.db import async_session_maker
from backend.models.orchestration_run import OrchestrationRun
from backend.models.skill import Skill as SkillRow
from backend.routes.skills_store import _skill_to_market_row
from backend.routes.tasks import _chat_direct_before_agent, _chat_force_skill_mode
from backend.schemas.orchestration import (
    OrchestrationExecution,
    OrchestrationOutput,
    OrchestrationPayload,
    OrchestrationProject,
    OrchestrationScenario,
    OrchestrationSkills,
    OrchestrationUserInput,
)
from backend.services.skill_lifecycle import SkillLifecycleService, sync_workspace_skills
from backend.services.skill_loader import Skill as SkillBase
from backend.services.skill_loader import SkillLoader
from backend.services.skill_metrics_service import build_skill_metrics
from backend.services.workshop_llm_generator import (
    _compose_fallback_deliverable,
    _reject_invalid_input,
)


class _SchemaSkill(SkillBase):
    skill_meta = {"input_schema": {"tech_name": "string", "user_value": "string"}}

    @property
    def name(self) -> str:
        return "schema_skill"

    def validate_input(self, input_data):
        return bool(isinstance(input_data, dict) and input_data.get("tech_name"))

    def generate(self, context):
        return {"content": "ok"}


def _single_skill_payload() -> OrchestrationPayload:
    return OrchestrationPayload(
        request_id="req_skill_registry",
        entrypoint="chat",
        project=OrchestrationProject(id="p1", name="test"),
        scenario=OrchestrationScenario(id="speech", name="发言稿"),
        skills=OrchestrationSkills(
            mode="allowed_list",
            allowed=["speech_skill"],
            allow_agent_free_choice=False,
        ),
        output=OrchestrationOutput(),
        execution=OrchestrationExecution(stream=True),
        user_input=OrchestrationUserInput(message="写一版发言稿"),
    )


def test_reject_invalid_input_lists_missing_fields():
    rejected = _reject_invalid_input(_SchemaSkill(), {})
    assert rejected is not None
    assert rejected["missing_fields"] == ["tech_name", "user_value"]
    assert "知识库集合" in rejected["suggested_collection"]


def test_fallback_deliverable_does_not_invent_promises():
    body = _compose_fallback_deliverable(_SchemaSkill(), {"tech_name": "超充"})
    assert "130km" not in body
    assert "帮助团队减少重复摸索" not in body
    assert "待补充：user_value" in body


def test_co_create_single_skill_uses_fallback_not_preempt():
    payload = _single_skill_payload()
    assert _chat_force_skill_mode(payload, chat_mode="co_create") is True
    assert _chat_direct_before_agent(payload, chat_mode="co_create") is False


def test_marketplace_rows_empty_without_prototype():
    assert _skill_to_market_row  # 市场行只来自已登记技能
    from backend.routes import skills_store

    assert not hasattr(skills_store, "MARKETPLACE_CATALOG")


def test_marketplace_endpoint_empty_when_registry_empty(monkeypatch):
    async def _empty(self, enabled_only=False, viewer_user_id=None):
        del enabled_only, viewer_user_id
        return []

    monkeypatch.setattr(SkillLifecycleService, "list_skills", _empty)
    with TestClient(app) as client:
        response = client.get("/api/v1/skills/marketplace")
    assert response.status_code == 200
    assert response.json() == []


@pytest.mark.asyncio
async def test_sync_workspace_skills_is_idempotent_and_skips_tests(tmp_path):
    name = f"wsreg_{uuid.uuid4().hex[:8]}"
    skill_dir = tmp_path / name
    skill_dir.mkdir()
    (skill_dir / "__init__.py").write_text("class Unused: pass\n", encoding="utf-8")
    (skill_dir / "skill.json").write_text(
        json.dumps({"name": "登记测试", "description": "仅测试", "version": "9.9.9"}, ensure_ascii=False),
        encoding="utf-8",
    )
    smoke = tmp_path / "smoke_should_skip"
    smoke.mkdir()
    (smoke / "skill.json").write_text("{}", encoding="utf-8")
    (smoke / "__init__.py").write_text("", encoding="utf-8")

    loader = SkillLoader(str(tmp_path))
    async with async_session_maker() as db:
        first = await sync_workspace_skills(db, loader)
        second = await sync_workspace_skills(db, loader)
        row = await db.execute(SkillRow.__table__.select().where(SkillRow.name == name))
        stored = row.mappings().first()
        await db.execute(SkillRow.__table__.delete().where(SkillRow.name == name))
        await db.commit()

    assert first["inserted"] == 1
    assert first["skipped_test"] >= 1
    assert second["inserted"] == 0
    assert second["skipped_existing"] >= 1
    assert stored is not None
    assert stored["source"] == "workspace"
    assert stored["enabled"] == 1
    assert stored["version"] == "9.9.9"


@pytest.mark.asyncio
async def test_sync_does_not_reenable_existing_skill(tmp_path):
    name = f"wskeep_{uuid.uuid4().hex[:8]}"
    skill_dir = tmp_path / name
    skill_dir.mkdir()
    (skill_dir / "__init__.py").write_text("", encoding="utf-8")
    (skill_dir / "skill.json").write_text(
        json.dumps({"description": "保持禁用", "version": "1.0.0"}),
        encoding="utf-8",
    )
    async with async_session_maker() as db:
        db.add(
            SkillRow(
                id=str(uuid.uuid4()),
                name=name,
                description="用户已禁用",
                version="1.0.0",
                enabled=0,
                source="workspace",
                owner_id="",
            )
        )
        await db.commit()
        stats = await sync_workspace_skills(db, SkillLoader(str(tmp_path)))
        row = await db.execute(SkillRow.__table__.select().where(SkillRow.name == name))
        stored = row.mappings().first()
        await db.execute(SkillRow.__table__.delete().where(SkillRow.name == name))
        await db.commit()

    assert stats["inserted"] == 0
    assert stored is not None
    assert stored["enabled"] == 0
    assert stored["description"] == "用户已禁用"


@pytest.mark.asyncio
async def test_chat_run_counts_toward_skill_metrics():
    run_id = str(uuid.uuid4())
    skill_name = f"metric_{uuid.uuid4().hex[:6]}"
    async with async_session_maker() as db:
        db.add(
            OrchestrationRun(
                id=run_id,
                entrypoint="chat",
                status="completed",
                user_id="metric_user",
                skills_policy_json=json.dumps(
                    {"mode": "allowed_list", "allowed": [skill_name], "allow_agent_free_choice": False}
                ),
                created_at=datetime.now().isoformat(),
            )
        )
        await db.commit()
        metrics = await build_skill_metrics(
            db,
            since=(datetime.now() - timedelta(days=1)).isoformat(),
            top=500,
        )
        await db.execute(OrchestrationRun.__table__.delete().where(OrchestrationRun.id == run_id))
        await db.commit()

    matched = [row for row in metrics["skill_usage"] if row["skill_name"] == skill_name]
    assert matched
    assert matched[0]["call_count"] >= 1
