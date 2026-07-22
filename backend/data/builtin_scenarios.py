"""
内置场景种子数据：与工坊 /create 默认场景对齐。

v2.0.0：按 TPD 技术品牌 ~23 个生产技能与高频业务链路重规划为 8 场景。
id 保持稳定（与历史 URL / 项目绑定兼容），语义与技能合同按业务域刷新。
"""

from __future__ import annotations

from typing import Any


def _domain(
    technical: list[str] | None = None,
    business: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "technical_scope": technical or [],
        "business_scope": business or [],
        "excluded_topics": [],
        "terminology_policy": "tpd_standard",
    }


def _knowledge(*, top_k: int = 5, cite: bool = False) -> dict[str, Any]:
    return {
        "mode": "restricted",
        "collections": [],
        "project_bound": True,
        "top_k": top_k,
        "fallback_policy": "cache_allowed",
    }


def _skills_manual(allowed: list[str]) -> dict[str, Any]:
    """工坊强制白名单：allowed[0] 为主技能，其余为同场景可选。"""
    return {
        "mode": "manual_only",
        "allowed": list(allowed),
        "preferred": [],
        "forbidden": [],
        "allow_agent_free_choice": False,
    }


def _skills_agent() -> dict[str, Any]:
    return {
        "mode": "agent_select",
        "allowed": [],
        "preferred": [],
        "forbidden": [],
        "allow_agent_free_choice": True,
    }


def _output(
    *,
    sections: list[str],
    skill_name: str | None = None,
    must_cite: bool = False,
    must_headings: bool = True,
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "template_id": None,
        "format": "markdown",
        "must_follow_template": bool(skill_name),
        "required_sections": sections,
        "validation_rules": {
            "must_have_headings": must_headings,
            "must_cite_sources": must_cite,
        },
    }
    if skill_name:
        out["skill_name"] = skill_name
    return out


# id 同时作为 scenario_profiles 主键，便于 URL 与旧代码引用稳定。
BUILTIN_SCENARIOS: list[dict[str, Any]] = [
    {
        "id": "general",
        "code": "general",
        "name": "通用协作",
        "description": "项目内通用问答与协作，不强制绑定技能",
        "category": "通用",
        "goal": "通用协作与问答",
        "conversation_mode": "collaborative",
        "preset_instructions": (
            "你是技术品牌与技术推广协作助手。优先结合项目上下文回答，"
            "需要结构化交付物时引导用户切换到对应业务场景。"
        ),
        "opening_hint": "可直接提问，或切换到业务场景做结构化产出。",
        "domain_json": _domain(),
        "knowledge_policy_json": _knowledge(top_k=5),
        "skills_policy_json": _skills_agent(),
        "output_policy_json": _output(sections=[], must_headings=False),
    },
    {
        "id": "refine",
        "code": "refine",
        "name": "结果优化",
        "description": "对已有输出润色、扩写、重写或对齐口径",
        "category": "工坊",
        "goal": "对已有内容继续优化和重写",
        "conversation_mode": "task_oriented",
        "preset_instructions": (
            "在保留事实与关键结论的前提下，按任务说明优化给定材料；"
            "不要无依据新增技术参数或承诺。"
        ),
        "opening_hint": "请附上待优化正文，并说明优化目标（精简 / 扩写 / 改口径等）。",
        "domain_json": _domain(business=["结果优化"]),
        "knowledge_policy_json": _knowledge(top_k=5),
        "skills_policy_json": {
            "mode": "manual_only",
            "allowed": [],
            "preferred": [],
            "forbidden": [],
            "allow_agent_free_choice": False,
        },
        "output_policy_json": _output(sections=[], must_headings=False),
    },
    {
        "id": "tech-doc",
        "code": "tech-insight",
        "name": "技术趋势洞察",
        "description": "行业趋势、品牌调研计划/报告与竞品对标",
        "category": "洞察调研",
        "goal": "输出可评审的趋势洞察或调研材料",
        "conversation_mode": "task_oriented",
        "preset_instructions": (
            "围绕技术品牌与行业趋势输出结构化洞察；结论先行，标注假设与待核实项。"
        ),
        "opening_hint": "请提供行业/本品/竞品背景，以及要输出的报告类型（趋势 / 调研计划 / 调研报告 / 对标）。",
        "domain_json": _domain(
            technical=["行业趋势", "竞品对标"],
            business=["技术品牌调研", "营销洞察"],
        ),
        "knowledge_policy_json": _knowledge(top_k=8, cite=True),
        "skills_policy_json": _skills_manual(
            [
                "tech_trend_skill",
                "brand_research_plan",
                "brand_research_report",
                "benchmark_skill",
            ]
        ),
        "output_policy_json": _output(
            sections=["执行摘要", "行业洞察", "核心发现", "策略建议"],
            skill_name="tech_trend_skill",
            must_cite=True,
        ),
    },
    {
        "id": "data-report",
        "code": "ip-strategy",
        "name": "技术IP包装策略",
        "description": "IP 全案、货架、矩阵、命名、互锁地图与车型赋能策略",
        "category": "IP策略",
        "goal": "输出技术 IP 包装与品牌策略材料",
        "conversation_mode": "task_oriented",
        "preset_instructions": (
            "以技术 IP 为核心组织策略：定位、信息屋、车型节奏与传播互锁需自洽。"
        ),
        "opening_hint": "请提供技术 IP 名称、能力卖点、目标车型与竞品信息。",
        "domain_json": _domain(
            technical=["技术IP", "技术品牌"],
            business=["包装策略", "车型赋能"],
        ),
        "knowledge_policy_json": _knowledge(top_k=6),
        "skills_policy_json": _skills_manual(
            [
                "ip_pack_skill",
                "ip_shelf_skill",
                "ip_matrix_skill",
                "brand_name_skill",
                "tech_lockmap_skill",
                "model_brand_skill",
            ]
        ),
        "output_policy_json": _output(
            sections=["背景洞察", "IP定位", "包装策略", "车型互锁", "执行计划"],
            skill_name="ip_pack_skill",
        ),
    },
    {
        "id": "prd",
        "code": "tech-comm",
        "name": "技术传播策划",
        "description": "IP 传播方案、事件传播稿、素材清单与 A4 一页纸",
        "category": "传播",
        "goal": "输出可落地的技术传播与公关材料",
        "conversation_mode": "task_oriented",
        "preset_instructions": (
            "输出需可直接用于传播评审：目标、受众、节奏、渠道与核心话术对齐。"
        ),
        "opening_hint": "请提供传播主题、目标受众、时间节点与可用预算/渠道。",
        "domain_json": _domain(
            technical=["技术传播"],
            business=["公关传播", "素材策划"],
        ),
        "knowledge_policy_json": _knowledge(top_k=5),
        "skills_policy_json": _skills_manual(
            [
                "ip_comm_plan",
                "tech_pr_skill",
                "material_skill",
                "a4_skill",
            ]
        ),
        "output_policy_json": _output(
            sections=["传播目标", "受众分层", "核心信息", "节奏与渠道", "效果评估"],
            skill_name="ip_comm_plan",
        ),
    },
    {
        "id": "marketing",
        "code": "tech-event",
        "name": "技术活动与展具",
        "description": "活动策划、展具概念/立项/说明书与 IP 认证方案",
        "category": "活动展具",
        "goal": "输出技术活动或展具相关策划与交付文档",
        "conversation_mode": "task_oriented",
        "preset_instructions": (
            "活动与展具方案需明确目标、场地约束、互动体验、预算与排期。"
        ),
        "opening_hint": "请提供展会/活动信息、展示目标、预算与周期约束。",
        "domain_json": _domain(
            technical=["展具", "技术展示"],
            business=["活动策划", "认证传播"],
        ),
        "knowledge_policy_json": _knowledge(top_k=5),
        "skills_policy_json": _skills_manual(
            [
                "event_plan_skill",
                "display_concept_skill",
                "display_project_skill",
                "display_guide_skill",
                "ip_cert_plan",
            ]
        ),
        "output_policy_json": _output(
            sections=["活动概述", "参展目标", "展台/展具策略", "时间节点", "任务分工"],
            skill_name="event_plan_skill",
        ),
    },
    {
        "id": "debug",
        "code": "exec-speech",
        "name": "领导讲稿与采访",
        "description": "发布会讲稿、发言稿与领导采访 QA",
        "category": "口播内容",
        "goal": "输出可上台的讲稿或采访应答材料",
        "conversation_mode": "task_oriented",
        "preset_instructions": (
            "讲稿与 QA 需口径统一、可朗读；敏感问题给桥梁话术，避免过度承诺。"
        ),
        "opening_hint": "请提供活动场景、核心主张、必须覆盖的技术点与敏感问题清单。",
        "domain_json": _domain(
            technical=["技术叙事"],
            business=["发布会", "领导采访"],
        ),
        "knowledge_policy_json": _knowledge(top_k=5),
        "skills_policy_json": _skills_manual(
            [
                "speech_draft_skill",
                "speech_skill",
                "interview_qa_skill",
            ]
        ),
        "output_policy_json": _output(
            sections=["开篇定调", "技术叙事", "用户价值", "号召与致谢"],
            skill_name="speech_draft_skill",
        ),
    },
    {
        "id": "kb-qa",
        "code": "content-sales",
        "name": "视频与销售赋能",
        "description": "导演脚本、短视频口播与销售话术手册",
        "category": "内容销售",
        "goal": "输出视频脚本或销售一线赋能话术",
        "conversation_mode": "task_oriented",
        "preset_instructions": (
            "内容需可拍可讲：钩子清晰、证据点可核验；销售话术需可落地到 4S 场景。"
        ),
        "opening_hint": "请提供推广主题、核心卖点、对标竞品与目标用户类型。",
        "domain_json": _domain(
            technical=["技术展示"],
            business=["视频内容", "销售赋能"],
        ),
        "knowledge_policy_json": _knowledge(top_k=5),
        "skills_policy_json": _skills_manual(
            [
                "video_script_skill",
                "video_skill",
                "sales_skill",
            ]
        ),
        "output_policy_json": _output(
            sections=["核心创意", "分镜/口播结构", "证据点", "行动号召"],
            skill_name="video_script_skill",
        ),
    },
]

BUILTIN_VERSION = "2.0.0"

# 覆盖的生产技能（不含测试/烟测包）
BUILTIN_COVERED_SKILLS: frozenset[str] = frozenset(
    skill
    for row in BUILTIN_SCENARIOS
    for skill in (row.get("skills_policy_json") or {}).get("allowed") or []
)
