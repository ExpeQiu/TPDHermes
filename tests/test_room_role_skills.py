"""共创角色技能：从人设拆出，并按工坊工具写入主笔提示。"""

from __future__ import annotations

import sys
from pathlib import Path

from backend.services.role_skills import role_workshop_skills, strip_legacy_skill_sentence
from backend.services.room_writer import build_writer_messages

_MULTI_AGENT = Path(__file__).resolve().parents[1] / "TPD-multi-agent"
if str(_MULTI_AGENT) not in sys.path:
    sys.path.insert(0, str(_MULTI_AGENT))

from multi_agent.roles import load_role, normalize_role  # noqa: E402
from multi_agent.utils.errors import MultiAgentError  # noqa: E402
import pytest  # noqa: E402


def test_legacy_system_sentence_becomes_skill_ids():
    role = normalize_role(
        {
            "id": "brand_researcher",
            "name": "品牌调研官",
            "kinds": ["consult"],
            "system": "你是品牌调研官。对齐 skills：tech_trend_skill、benchmark_skill。交付要有来源。",
        }
    )
    assert role["skills"] == ["tech_trend_skill", "benchmark_skill"]
    assert "对齐" not in role["system"]
    assert "交付要有来源" in role["system"]


def test_explicit_skills_win_over_legacy_sentence():
    role = normalize_role(
        {
            "id": "brand_researcher",
            "name": "品牌调研官",
            "kinds": ["consult"],
            "skills": ["benchmark_skill"],
            "system": "你是品牌调研官。对齐 skills：tech_trend_skill。",
        }
    )
    assert role["skills"] == ["benchmark_skill"]
    assert "tech_trend_skill" not in role["system"]


def test_invalid_skill_id_rejected():
    with pytest.raises(MultiAgentError):
        normalize_role(
            {
                "id": "brand_researcher",
                "name": "品牌调研官",
                "kinds": ["consult"],
                "skills": ["Tech Trend"],
            }
        )


def test_catalog_role_keeps_structured_skills():
    role = load_role("brand_researcher")
    assert role["skills"] == [
        "brand_research_plan",
        "brand_research_report",
        "tech_trend_skill",
        "benchmark_skill",
    ]
    assert "对齐 skills" not in role["system"]
    slot = role["system"]
    assert "品牌调研官" in slot


def test_writer_prompt_calls_workshop_not_skill_files():
    role = {
        "id": "brand_researcher",
        "name": "品牌调研官",
        "system": "你是品牌调研官。对齐 skills：tech_trend_skill、benchmark_skill。",
        "skills": ["tech_trend_skill", "benchmark_skill"],
    }
    messages = build_writer_messages(
        role,
        {
            "allow_write": True,
            "run_id": "run-room-1",
            "project_id": "project-1",
            "execution_token": "grant-1",
            "human_text": "写一版技术趋势",
        },
    )
    system = messages[0]["content"]
    assert "workshop_generate" in system
    assert "workshop_generate_from_kb" in system
    assert "tech_trend_skill" in system
    assert "TPCharness_run_id=run-room-1" in system
    assert "execution_token=grant-1" in system
    assert "project_id=project-1" in system
    assert "skill_view" in system
    assert "不要调用 skill_view" in system
    assert "不要读取 /opt/project-skills" in system
    assert "读到技能后" not in system
    assert "写出全文" not in system
    assert "对齐 skills" not in system
    assert role_workshop_skills(role) == ["tech_trend_skill", "benchmark_skill"]
    assert "对齐" not in strip_legacy_skill_sentence(role["system"])
