"""skill_script_runner 单元测试。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.services.skill_loader import SkillLoader
from backend.services.skill_script_runner import generate_content_from_scripts

STUB_SKILLS = [
    "brand_name_skill",
    "brand_research_plan",
    "brand_research_report",
    "display_concept_skill",
    "display_guide_skill",
    "display_project_skill",
    "ip_cert_plan",
    "ip_pack_skill",
    "ip_shelf_skill",
]

ROOT = Path(__file__).resolve().parent.parent
SKILLS_ROOT = ROOT / "skills"


def test_list_skill_metadata_discovers_templates_folder_without_skill_json() -> None:
    """编排页元数据应能扫描 templates/*.md，不依赖 skill.json 显式声明。"""
    loader = SkillLoader(str(SKILLS_ROOT))
    meta = {row["name"]: row for row in loader.list_skill_metadata()}
    speech_draft = meta["speech_draft_skill"]
    paths = [t["path"] for t in speech_draft["templates"]]
    assert "templates/speech_draft.md" in paths


@pytest.mark.parametrize("skill_name", STUB_SKILLS)
def test_stub_skills_render_markdown(skill_name: str) -> None:
    skill_dir = SKILLS_ROOT / skill_name
    example = skill_dir / "assets" / "input.example.json"
    context = json.loads(example.read_text(encoding="utf-8")) if example.is_file() else {}

    content = generate_content_from_scripts(skill_dir, context)

    assert isinstance(content, str)
    assert len(content) > 200
    assert "#" in content


@pytest.mark.parametrize("skill_name", STUB_SKILLS)
def test_stub_skills_generate_returns_content(skill_name: str) -> None:
    loader = SkillLoader(str(SKILLS_ROOT))
    if skill_name in loader._cache:
        del loader._cache[skill_name]

    skill = loader.load(skill_name)
    example = SKILLS_ROOT / skill_name / "assets" / "input.example.json"
    context = json.loads(example.read_text(encoding="utf-8")) if example.is_file() else {}

    result = skill.generate(context)

    assert "content" in result
    assert isinstance(result["content"], str)
    assert len(result["content"]) > 200
