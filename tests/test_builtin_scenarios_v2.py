"""内置 8 场景与技能覆盖校验。"""

from backend.data.builtin_scenarios import (
    BUILTIN_COVERED_SKILLS,
    BUILTIN_SCENARIOS,
    BUILTIN_VERSION,
)


def test_builtin_scenarios_count_and_stable_ids():
    assert len(BUILTIN_SCENARIOS) == 8
    ids = [row["id"] for row in BUILTIN_SCENARIOS]
    assert ids == [
        "general",
        "refine",
        "tech-doc",
        "data-report",
        "prd",
        "marketing",
        "debug",
        "kb-qa",
    ]
    assert BUILTIN_VERSION == "2.0.0"


def test_builtin_scenarios_cover_production_skills():
    # 23 个生产技能：18 标准包 + a4/benchmark/ip_matrix/material/sales
    expected = {
        "tech_trend_skill",
        "brand_research_plan",
        "brand_research_report",
        "benchmark_skill",
        "ip_pack_skill",
        "ip_shelf_skill",
        "ip_matrix_skill",
        "brand_name_skill",
        "tech_lockmap_skill",
        "model_brand_skill",
        "ip_comm_plan",
        "tech_pr_skill",
        "material_skill",
        "a4_skill",
        "event_plan_skill",
        "display_concept_skill",
        "display_project_skill",
        "display_guide_skill",
        "ip_cert_plan",
        "speech_draft_skill",
        "speech_skill",
        "interview_qa_skill",
        "video_script_skill",
        "video_skill",
        "sales_skill",
    }
    assert expected <= BUILTIN_COVERED_SKILLS
    assert len(BUILTIN_COVERED_SKILLS) >= 23


def test_workshop_scenarios_bind_manual_skills():
    for row in BUILTIN_SCENARIOS:
        if row["id"] in ("general", "refine"):
            continue
        policy = row["skills_policy_json"]
        assert policy["mode"] == "manual_only"
        assert policy["allow_agent_free_choice"] is False
        assert len(policy["allowed"]) >= 1
        assert row["output_policy_json"].get("skill_name") == policy["allowed"][0]
