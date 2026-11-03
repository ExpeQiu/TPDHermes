"""项目技能目录允许后台审查改写，删除和目录外技能仍然拒绝。"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HERMES = ROOT / "hermes-agent" / "hermes-agent-main"
if str(HERMES) not in sys.path:
    sys.path.insert(0, str(HERMES))

from tools.skill_manager_guards import (  # noqa: E402
    project_skill_autowrite_allowed,
    snapshot_project_skill,
)


def test_only_patch_like_writes_inside_the_root_are_unlocked(tmp_path, monkeypatch):
    root = tmp_path / "skills"
    skill = root / "speech_skill"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("原步骤\n", encoding="utf-8")
    monkeypatch.setenv("HERMES_PROJECT_SKILL_ROOTS", str(root))

    assert project_skill_autowrite_allowed(skill, "patch") is True
    assert project_skill_autowrite_allowed(skill, "edit") is True
    assert project_skill_autowrite_allowed(skill, "write_file") is True
    assert project_skill_autowrite_allowed(skill, "delete") is False

    outside = tmp_path / "other" / "speech_skill"
    outside.mkdir(parents=True)
    assert project_skill_autowrite_allowed(outside, "patch") is False


def test_unlocked_write_snapshots_the_skill_first(tmp_path, monkeypatch):
    root = tmp_path / "skills"
    skill = root / "speech_skill"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("原步骤\n", encoding="utf-8")
    monkeypatch.setenv("HERMES_PROJECT_SKILL_ROOTS", str(root))

    dest = snapshot_project_skill(skill)
    assert dest.is_dir()
    assert dest.parent.parent == root / ".versions"
    assert (dest / "SKILL.md").read_text(encoding="utf-8") == "原步骤\n"
    assert (skill / "SKILL.md").read_text(encoding="utf-8") == "原步骤\n"
