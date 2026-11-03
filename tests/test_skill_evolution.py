"""对话纠正落到技能正文，并保留可回滚的版本快照。"""

from __future__ import annotations

import json
import uuid
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from backend.models.chat_session import ChatMessageRecord, ChatSessionRecord
from backend.models.feedback_event import FeedbackEvent
from backend.models.project_room import ProjectRoomMessage
from backend.models.learning_signal import LearningSignal
from backend.models.skill import Skill as SkillRow
from backend.services.skill_evolution import (
    Episode,
    append_evolved_rule,
    evolve_recent,
    normalize_rule,
    plan_actions,
    rule_id_for,
)
from backend.services.skill_lifecycle import SkillLifecycleService
from backend.services.skill_loader import SkillLoader
from backend.services.skill_version import SkillVersionService

RULE = "不要写太长，改成三条要点"


def test_noise_and_generic_advice_are_not_rules():
    assert normalize_rule("command not found") is None
    assert normalize_rule("建议更新该场景 Skill 模板") is None
    assert normalize_rule("太短") is None
    assert normalize_rule(RULE) == RULE


def test_single_episode_does_not_change_skills():
    rule = normalize_rule(RULE)
    actions = plan_actions(
        [Episode(rule=rule, skill_name="speech_skill", evidence_id="a")],
        {"speech_skill"},
    )
    assert actions == []


def test_repeated_signal_patches_known_skill():
    rule = normalize_rule(RULE)
    actions = plan_actions(
        [Episode(rule=rule, skill_name="speech_skill", evidence_id="signal:1", weight=2)],
        {"speech_skill"},
    )
    assert len(actions) == 1
    assert actions[0].action == "patch"
    assert actions[0].skill_name == "speech_skill"
    assert actions[0].support == 2


def test_repeated_correction_without_skill_creates_learned_name():
    rule = normalize_rule(RULE)
    actions = plan_actions(
        [
            Episode(rule=rule, skill_name=None, evidence_id="a"),
            Episode(rule=rule, skill_name=None, evidence_id="b"),
        ],
        set(),
    )
    assert actions[0].action == "create"
    assert actions[0].skill_name == f"learned_{rule_id_for(rule)}"


def test_append_rule_is_idempotent_under_section():
    rule_id = "abc123abc123"
    base = "# 测试\n\n## 使用说明\n\n原步骤。\n"
    once = append_evolved_rule(base, RULE, rule_id, 2)
    twice = append_evolved_rule(once, RULE, rule_id, 4)
    assert once == twice
    assert once.count(f"evolved:{rule_id}") == 1
    assert once.index("## 自进化") < once.index(f"evolved:{rule_id}")
    assert once.index("## 使用说明") < once.index("## 自进化")


def _write_skill(root: Path, name: str) -> None:
    package = root / name
    package.mkdir(parents=True)
    (package / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: 测试技能。\n---\n\n# 测试\n\n## 使用说明\n\n原步骤。\n",
        encoding="utf-8",
    )
    (package / "__init__.py").write_text(
        "from backend.services.skill_loader import Skill\n\n"
        "class EvoProbeSkill(Skill):\n"
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
        ChatSessionRecord.__table__,
        ChatMessageRecord.__table__,
        ProjectRoomMessage.__table__,
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


@pytest.mark.asyncio
async def test_signal_patches_skill_and_restore_keeps_previous_snapshot(tmp_path, monkeypatch):
    name = "evopatch"
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

            first = await evolve_recent(db, days=14, loader=loader)
            assert first["patched"][0]["skill"] == name
            assert first["patched"][0]["version"] == "1.0.1"
            live = (skills / name / "SKILL.md").read_text(encoding="utf-8")
            assert "原步骤" in live
            assert "三条要点" in live
            previous = tmp_path / "versions" / name / "1.0.0" / "SKILL.md"
            assert "自进化" not in previous.read_text(encoding="utf-8")

            second = await evolve_recent(db, days=14, loader=loader)
            assert second["patched"] == []
            assert second["skipped"][0]["reason"] == "duplicate"
            stored = await SkillLifecycleService(db, loader).get_skill(name)
            assert stored["version"] == "1.0.1"

            restored = await SkillLifecycleService(db, loader).restore_version(name, "1.0.0")
            assert restored["version"] == "1.0.0"
            rolled = (skills / name / "SKILL.md").read_text(encoding="utf-8")
            assert "自进化" not in rolled
            assert "三条要点" in (tmp_path / "versions" / name / "1.0.1" / "SKILL.md").read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_workspace_skill_without_snapshot_keeps_preimage(tmp_path, monkeypatch):
    name = "evoworkspace"
    async with _db(tmp_path, monkeypatch) as (maker, skills):
        async with maker() as db:
            _write_skill(skills, name)
            loader = SkillLoader(str(skills))
            now = datetime.now().isoformat()
            db.add(
                SkillRow(
                    id=str(uuid.uuid4()),
                    name=name,
                    description="测试技能。",
                    config="{}",
                    version="1.0.0",
                    enabled=1,
                    source="workspace",
                    owner_id="",
                    version_history="[]",
                    installed_at=now,
                    updated_at=now,
                )
            )
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
            result = await evolve_recent(db, days=14, loader=loader)
            assert result["patched"][0]["version"] == "1.0.1"
            preimage = (tmp_path / "versions" / name / "1.0.0" / "SKILL.md").read_text(encoding="utf-8")
            assert "原步骤" in preimage
            assert "自进化" not in preimage


@pytest.mark.asyncio
async def test_chat_corrections_patch_skill(tmp_path, monkeypatch):
    name = "evochat"
    async with _db(tmp_path, monkeypatch) as (maker, skills):
        async with maker() as db:
            loader = await _install(db, skills, name)
            now = datetime.now().isoformat()
            session_id = str(uuid.uuid4())
            db.add(
                ChatSessionRecord(
                    id=session_id,
                    user_id="evo",
                    title="纠正",
                    created_at_ms=1,
                )
            )
            for _ in range(2):
                db.add(
                    ChatMessageRecord(
                        id=str(uuid.uuid4()),
                        session_id=session_id,
                        role="user",
                        content=RULE,
                        metadata_json=json.dumps({"skill": name}),
                        created_at=now,
                    )
                )
            await db.commit()
            result = await evolve_recent(db, days=14, loader=loader)
            assert result["patched"][0]["skill"] == name
            assert "三条要点" in (skills / name / "SKILL.md").read_text(encoding="utf-8")


@pytest.mark.asyncio
async def test_unmatched_corrections_create_versioned_skill(tmp_path, monkeypatch):
    async with _db(tmp_path, monkeypatch) as (maker, skills):
        async with maker() as db:
            loader = SkillLoader(str(skills))
            now = datetime.now().isoformat()
            for _ in range(2):
                db.add(
                    FeedbackEvent(
                        id=str(uuid.uuid4()),
                        user_id="evo",
                        adoption_level="reject",
                        reaction_type="rewrite",
                        scenario_id="no_such_scene",
                        reason_text=RULE,
                        created_at=now,
                    )
                )
            await db.commit()
            result = await evolve_recent(db, days=14, loader=loader)
            created = result["created"][0]
            skill_name = created["skill"]
            assert skill_name == f"learned_{rule_id_for(normalize_rule(RULE))}"
            assert created["version"] == "1.0.0"
            text = (skills / skill_name / "SKILL.md").read_text(encoding="utf-8")
            assert "三条要点" in text
            stored = await SkillLifecycleService(db, loader).get_skill(skill_name)
            assert stored["source"] == "learned"
            assert (tmp_path / "versions" / skill_name / "1.0.0").is_dir()

            again = await evolve_recent(db, days=14, loader=loader)
            assert again["created"] == []
            assert again["skipped"][0]["reason"] == "duplicate"
            latest = await SkillLifecycleService(db, loader).get_skill(skill_name)
            assert latest["version"] == "1.0.0"


@pytest.mark.asyncio
async def test_room_corrections_create_learned_skill(tmp_path, monkeypatch):
    async with _db(tmp_path, monkeypatch) as (maker, skills):
        async with maker() as db:
            loader = SkillLoader(str(skills))
            now = datetime.now().isoformat()
            for seq in (1, 2):
                db.add(
                    ProjectRoomMessage(
                        id=str(uuid.uuid4()),
                        room_id="room-1",
                        seq=seq,
                        turn_id=f"turn-{seq}",
                        author_type="human",
                        author_id="person",
                        content=RULE,
                        created_at=now,
                    )
                )
            await db.commit()
            result = await evolve_recent(db, days=14, loader=loader)
            assert result["created"][0]["skill"].startswith("learned_")


@pytest.mark.asyncio
async def test_single_or_disabled_evolution_does_not_write(tmp_path, monkeypatch):
    name = "evoskip"
    async with _db(tmp_path, monkeypatch) as (maker, skills):
        async with maker() as db:
            loader = await _install(db, skills, name)
            db.add(
                FeedbackEvent(
                    id=str(uuid.uuid4()),
                    user_id="evo",
                    adoption_level="reject",
                    reason_text=RULE,
                    scenario_id=name,
                    created_at=datetime.now().isoformat(),
                )
            )
            db.add(
                FeedbackEvent(
                    id=str(uuid.uuid4()),
                    user_id="evo",
                    adoption_level="reject",
                    reason_text="command not found",
                    scenario_id=name,
                    created_at=datetime.now().isoformat(),
                )
            )
            await db.commit()
            quiet = await evolve_recent(db, days=14, loader=loader)
            assert quiet["patched"] == []
            assert quiet["created"] == []
            assert "自进化" not in (skills / name / "SKILL.md").read_text(encoding="utf-8")

            monkeypatch.setenv("SKILL_EVOLUTION_ENABLED", "false")
            db.add(
                FeedbackEvent(
                    id=str(uuid.uuid4()),
                    user_id="evo",
                    adoption_level="reject",
                    reason_text=RULE,
                    scenario_id=name,
                    created_at=datetime.now().isoformat(),
                )
            )
            await db.commit()
            disabled = await evolve_recent(db, days=14, loader=loader)
            assert disabled["enabled"] is False
            assert "自进化" not in (skills / name / "SKILL.md").read_text(encoding="utf-8")
