"""学习计划：夜窗入队、执行、验收回滚。"""

from __future__ import annotations

import json
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from backend.models.chat_session import ChatMessageRecord, ChatSessionRecord
from backend.models.experience_entry import ExperienceEntry
from backend.models.feedback_event import FeedbackEvent
from backend.models.learning_report import LearningReport
from backend.models.learning_signal import LearningSignal
from backend.models.learning_task import LearningTask
from backend.models.orchestration_run import OrchestrationRun
from backend.models.project_room import ProjectRoomMessage
from backend.models.scenario_profile import ScenarioProfile
from backend.models.skill import Skill as SkillRow
from backend.services.learning_plan_service import claim_one, enqueue_learning_plan, in_night_window
from backend.services.learning_service import analyze_feedbacks, generate_weekly_report
from backend.services.skill_lifecycle import SkillLifecycleService
from backend.services.skill_loader import SkillLoader
from backend.services.skill_version import SkillVersionService

RULE = "不要写太长，改成三条要点"


def test_night_window_bounds(monkeypatch):
    monkeypatch.setenv("LEARNING_PLAN_ENABLED", "true")
    monkeypatch.setenv("LEARNING_PLAN_WINDOW", "00:00-05:00")
    assert in_night_window(datetime(2026, 11, 15, 23, 59)) is False
    assert in_night_window(datetime(2026, 11, 16, 0, 0)) is True
    assert in_night_window(datetime(2026, 11, 16, 4, 59)) is True
    assert in_night_window(datetime(2026, 11, 16, 5, 0)) is False


def _write_skill(root: Path, name: str) -> None:
    package = root / name
    package.mkdir(parents=True)
    (package / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: 测试技能。\n---\n\n# 测试\n\n## 使用说明\n\n原步骤。\n",
        encoding="utf-8",
    )
    (package / "__init__.py").write_text(
        "from backend.services.skill_loader import Skill\n\n"
        "class PlanProbeSkill(Skill):\n"
        "    @property\n"
        "    def name(self):\n"
        f"        return {name!r}\n\n"
        "    def generate(self, context):\n"
        "        return {'content': 'ok'}\n",
        encoding="utf-8",
    )


@asynccontextmanager
async def _db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SKILL_EVOLUTION_ENABLED", "true")
    monkeypatch.setenv("LEARNING_PLAN_ENABLED", "true")
    monkeypatch.setenv("LEARNING_PLAN_WINDOW", "00:00-05:00")
    monkeypatch.setattr(SkillVersionService, "VERSION_ROOT", tmp_path / "versions")
    skills = tmp_path / "skills"
    skills.mkdir()
    engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    tables = (
        SkillRow.__table__,
        FeedbackEvent.__table__,
        LearningSignal.__table__,
        LearningTask.__table__,
        LearningReport.__table__,
        ChatSessionRecord.__table__,
        ChatMessageRecord.__table__,
        ProjectRoomMessage.__table__,
        ScenarioProfile.__table__,
        OrchestrationRun.__table__,
        ExperienceEntry.__table__,
    )
    async with engine.begin() as conn:
        for table in tables:
            await conn.run_sync(lambda sync_conn, table=table: table.create(sync_conn))
    maker = async_sessionmaker(engine, expire_on_commit=False)
    try:
        yield maker, skills
    finally:
        await engine.dispose()


async def _install(db: AsyncSession, skills: Path, name: str) -> SkillLoader:
    _write_skill(skills, name)
    loader = SkillLoader(str(skills))
    await SkillLifecycleService(db, loader).install(name=name, description="测试技能。", source="local")
    return loader


def _night(hour: int, minute: int = 0) -> datetime:
    """领取时刻必须晚于入队时写入的 due_at（真实当前时间）。"""
    start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
    return start.replace(hour=hour, minute=minute)


@pytest.mark.asyncio
async def test_enqueue_is_idempotent_and_daytime_claim_does_not_write(tmp_path, monkeypatch):
    name = "planpatch"
    async with _db(tmp_path, monkeypatch) as (maker, skills):
        async with maker() as db:
            loader = await _install(db, skills, name)
            now = datetime.now().isoformat()
            db.add(
                LearningSignal(
                    id=str(uuid.uuid4()),
                    signal_type="repeated_correction",
                    entity_kind="scenario",
                    entity_id=name,
                    entity_label=name,
                    count=2,
                    status="open",
                    payload_json=json.dumps({"reason_samples": [RULE]}, ensure_ascii=False),
                    last_seen_at=now,
                )
            )
            await db.commit()
            first = await enqueue_learning_plan(db, days=14)
            second = await enqueue_learning_plan(db, days=14)
            assert first["enqueued"] == 2
            assert second["enqueued"] == 0
            assert {item["kind"] for item in first["items"]} == {"patch_skill", "tune_scenario"}

            skipped = await claim_one(db, now=_night(23, 59), loader=loader, respect_quiet=False)
            assert skipped["reason"] == "outside_window"
            assert "自进化" not in (skills / name / "SKILL.md").read_text(encoding="utf-8")

            stopped = await claim_one(db, now=_night(5, 0), loader=loader, respect_quiet=False)
            assert stopped["reason"] == "outside_window"


@pytest.mark.asyncio
async def test_night_patch_rolls_back_when_metric_does_not_improve(tmp_path, monkeypatch):
    name = "planrollback"
    async with _db(tmp_path, monkeypatch) as (maker, skills):
        async with maker() as db:
            loader = await _install(db, skills, name)
            now = datetime.now().isoformat()
            db.add(
                LearningSignal(
                    id=str(uuid.uuid4()),
                    signal_type="repeated_correction",
                    entity_kind="scenario",
                    entity_id=name,
                    entity_label=name,
                    count=2,
                    status="open",
                    payload_json=json.dumps({"reason_samples": [RULE]}, ensure_ascii=False),
                    last_seen_at=now,
                )
            )
            await db.commit()
            await enqueue_learning_plan(db, days=14)
            applied = await claim_one(db, now=_night(1, 0), loader=loader, respect_quiet=False)
            assert applied["status"] == "verifying"
            live = (skills / name / "SKILL.md").read_text(encoding="utf-8")
            assert "三条要点" in live

            parent = await db.get(LearningTask, applied["task_id"])
            assert parent is not None
            baseline = json.loads(parent.baseline_json or "{}")
            baseline["value"] = 1
            parent.baseline_json = json.dumps(baseline)
            verify = (
                await db.execute(
                    LearningTask.__table__.select().where(LearningTask.parent_id == parent.id)
                )
            ).first()
            assert verify is not None
            verify_row = await db.get(LearningTask, verify.id)
            assert verify_row is not None
            verify_row.due_at = (_night(1, 0) - timedelta(minutes=1)).isoformat()
            await db.commit()

            checked = await claim_one(db, now=_night(1, 10), loader=loader, respect_quiet=False)
            assert checked["kind"] == "verify"
            rolled = (skills / name / "SKILL.md").read_text(encoding="utf-8")
            assert "自进化" not in rolled
            assert "原步骤" in rolled
            parent_after = await db.get(LearningTask, parent.id)
            assert parent_after is not None
            assert parent_after.status == "rolled_back"

            report = await generate_weekly_report(db)
            summary = json.loads(report.summary_json)
            assert summary["task_outcomes"]["rolled_back"] >= 1
            assert any("已回滚" in line for line in summary["pending_confirmations"])


@pytest.mark.asyncio
async def test_underused_signal_tunes_scenario_and_rolls_back(tmp_path, monkeypatch):
    name = "quiet_skill"
    async with _db(tmp_path, monkeypatch) as (maker, skills):
        async with maker() as db:
            loader = await _install(db, skills, name)
            skill = (await db.execute(SkillRow.__table__.select().where(SkillRow.name == name))).first()
            assert skill is not None
            stored = await db.get(SkillRow, skill.id)
            assert stored is not None
            stored.installed_at = (datetime.now() - timedelta(days=8)).isoformat()
            scenario = ScenarioProfile(
                id="scene-under",
                code="scene-under",
                name="低使用场景",
                domain_json="{}",
                knowledge_policy_json="{}",
                skills_policy_json=json.dumps({"allowed": [name]}),
                output_policy_json="{}",
                preset_instructions="原说明",
                version="1.0.0",
                status="published",
            )
            db.add(scenario)
            for index in range(5):
                db.add(
                    OrchestrationRun(
                        id=f"run-{index}",
                        entrypoint="task",
                        status="completed",
                        response_metadata_json="{}",
                        tool_capture_json="{}",
                        created_at=datetime.now().isoformat(),
                    )
                )
            await db.commit()

            signals = await analyze_feedbacks(db, days=14)
            under = [row for row in signals if row.signal_type == "skill_underused"]
            assert len(under) == 1
            payload = json.loads(under[0].payload_json or "{}")
            assert payload["scenario_id"] == "scene-under"

            again = await analyze_feedbacks(db, days=14)
            assert len([row for row in again if row.signal_type == "skill_underused"]) == 1

            queued = await enqueue_learning_plan(db, days=14)
            tune = [item for item in queued["items"] if item["kind"] == "tune_scenario"]
            assert len(tune) == 1
            second = await enqueue_learning_plan(db, days=14)
            assert second["enqueued"] == 0

            applied = await claim_one(db, now=_night(2, 0), loader=loader, respect_quiet=False)
            assert applied["kind"] == "tune_scenario"
            row = await db.get(ScenarioProfile, "scene-under")
            assert row is not None
            assert row.status == "published"
            assert row.version == "1.0.1"
            assert "优先使用技能 quiet_skill" in (row.preset_instructions or "")
            assert json.loads(row.skills_policy_json)["allowed"] == [name]
            assert row.domain_json == "{}"

            verify = await db.get(LearningTask, applied["task_id"])
            assert verify is not None
            child = (
                await db.execute(
                    LearningTask.__table__.select().where(LearningTask.parent_id == verify.id)
                )
            ).first()
            assert child is not None
            child_row = await db.get(LearningTask, child.id)
            assert child_row is not None
            child_row.due_at = (_night(2, 0) - timedelta(minutes=1)).isoformat()
            await db.commit()
            await claim_one(db, now=_night(2, 20), loader=loader, respect_quiet=False)
            restored = await db.get(ScenarioProfile, "scene-under")
            assert restored is not None
            assert restored.preset_instructions == "原说明"
            assert restored.version == "1.0.0"
            assert restored.status == "published"


@pytest.mark.asyncio
async def test_fill_kb_writes_unpublished_entry_and_deletes_on_failed_verify(tmp_path, monkeypatch):
    async with _db(tmp_path, monkeypatch) as (maker, skills):
        async with maker() as db:
            loader = SkillLoader(str(skills))
            now = datetime.now().isoformat()
            db.add(
                LearningSignal(
                    id="sig-miss",
                    signal_type="kb_miss",
                    entity_kind="kb_term",
                    entity_id="public.internal_methodology.tpd_experience:制动热管理",
                    entity_label="制动热管理",
                    count=3,
                    status="open",
                    payload_json=json.dumps(
                        {
                            "query": "制动热管理",
                            "collection": "public.internal_methodology.tpd_experience",
                        },
                        ensure_ascii=False,
                    ),
                    last_seen_at=now,
                )
            )
            await db.commit()

            async def fake_add(**kwargs):
                assert kwargs["published"] is False
                assert "制动热管理" in kwargs["content"]
                return {"ok": True, "doc_id": "doc-miss"}

            deleted: list[dict] = []

            async def fake_delete(**kwargs):
                deleted.append(kwargs)
                return {"ok": True}

            monkeypatch.setattr(
                "backend.services.learning_plan_service.add_kb_harvest_entry",
                fake_add,
            )
            monkeypatch.setattr(
                "backend.services.learning_plan_service.delete_kb_entry",
                fake_delete,
            )
            queued = await enqueue_learning_plan(db, days=14)
            assert queued["items"][0]["kind"] == "fill_kb"
            applied = await claim_one(db, now=_night(3, 0), loader=loader, respect_quiet=False)
            assert applied["status"] == "verifying"
            entry = (
                await db.execute(ExperienceEntry.__table__.select())
            ).first()
            assert entry is not None
            assert entry.kb_doc_id == "doc-miss"
            assert entry.published == "false"

            child = (
                await db.execute(
                    LearningTask.__table__.select().where(LearningTask.parent_id == applied["task_id"])
                )
            ).first()
            assert child is not None
            child_row = await db.get(LearningTask, child.id)
            assert child_row is not None
            child_row.due_at = (_night(3, 0) - timedelta(minutes=1)).isoformat()
            await db.commit()
            await claim_one(db, now=_night(3, 20), loader=loader, respect_quiet=False)
            assert deleted and deleted[0]["doc_id"] == "doc-miss"
            left = (await db.execute(ExperienceEntry.__table__.select())).first()
            assert left is None


@pytest.mark.asyncio
async def test_create_skill_is_removed_when_verify_fails(tmp_path, monkeypatch):
    async with _db(tmp_path, monkeypatch) as (maker, skills):
        async with maker() as db:
            loader = SkillLoader(str(skills))
            now = datetime.now().isoformat()
            db.add(
                LearningSignal(
                    id="sig-create",
                    signal_type="repeated_correction",
                    entity_kind="note",
                    entity_id="none",
                    entity_label="none",
                    count=2,
                    status="open",
                    payload_json=json.dumps({"reason_samples": [RULE]}, ensure_ascii=False),
                    last_seen_at=now,
                )
            )
            await db.commit()
            queued = await enqueue_learning_plan(db, days=14)
            assert queued["items"][0]["kind"] == "create_skill"
            name = queued["items"][0]["target_id"]
            applied = await claim_one(db, now=_night(4, 0), loader=loader, respect_quiet=False)
            assert applied["status"] == "verifying"
            assert (skills / name / "SKILL.md").is_file()

            parent = await db.get(LearningTask, applied["task_id"])
            assert parent is not None
            baseline = json.loads(parent.baseline_json or "{}")
            baseline["value"] = 1
            parent.baseline_json = json.dumps(baseline)
            child = (
                await db.execute(
                    LearningTask.__table__.select().where(LearningTask.parent_id == parent.id)
                )
            ).first()
            assert child is not None
            child_row = await db.get(LearningTask, child.id)
            assert child_row is not None
            child_row.due_at = (_night(4, 0) - timedelta(minutes=1)).isoformat()
            await db.commit()
            await claim_one(db, now=_night(4, 20), loader=loader, respect_quiet=False)
            assert not (skills / name).exists()
            parent_after = await db.get(LearningTask, parent.id)
            assert parent_after is not None
            assert parent_after.status == "rolled_back"


@pytest.mark.asyncio
async def test_learning_plan_mock_e2e(tmp_path, monkeypatch):
    """白天只入队，夜窗改写技能，验收变差后回滚并记入周报。"""
    name = "plane2e"
    async with _db(tmp_path, monkeypatch) as (maker, skills):
        async with maker() as db:
            loader = await _install(db, skills, name)
            now = datetime.now().isoformat()
            db.add(
                LearningSignal(
                    id=str(uuid.uuid4()),
                    signal_type="repeated_correction",
                    entity_kind="scenario",
                    entity_id=name,
                    entity_label=name,
                    count=2,
                    status="open",
                    payload_json=json.dumps({"reason_samples": [RULE]}, ensure_ascii=False),
                    last_seen_at=now,
                )
            )
            await db.commit()
            queued = await enqueue_learning_plan(db, days=14)
            assert any(item["kind"] == "patch_skill" for item in queued["items"])
            skipped = await claim_one(db, now=_night(23, 59), loader=loader, respect_quiet=False)
            assert skipped["reason"] == "outside_window"
            assert "自进化" not in (skills / name / "SKILL.md").read_text(encoding="utf-8")

            applied = await claim_one(db, now=_night(1, 0), loader=loader, respect_quiet=False)
            assert applied["status"] == "verifying"
            assert "三条要点" in (skills / name / "SKILL.md").read_text(encoding="utf-8")
            parent = await db.get(LearningTask, applied["task_id"])
            assert parent is not None
            baseline = json.loads(parent.baseline_json or "{}")
            baseline["value"] = 1
            parent.baseline_json = json.dumps(baseline)
            child = (
                await db.execute(
                    LearningTask.__table__.select().where(LearningTask.parent_id == parent.id)
                )
            ).first()
            assert child is not None
            child_row = await db.get(LearningTask, child.id)
            assert child_row is not None
            child_row.due_at = (_night(1, 0) - timedelta(minutes=1)).isoformat()
            await db.commit()

            checked = await claim_one(db, now=_night(1, 20), loader=loader, respect_quiet=False)
            assert checked["kind"] == "verify"
            rolled = (skills / name / "SKILL.md").read_text(encoding="utf-8")
            assert "自进化" not in rolled
            assert "原步骤" in rolled
            report = await generate_weekly_report(db)
            summary = json.loads(report.summary_json)
            assert summary["task_outcomes"]["rolled_back"] >= 1
