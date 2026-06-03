#!/usr/bin/env python3
"""Generate a technology IP packaging plan from JSON input."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


DEFAULT_TITLE = "技术品牌（IP）包装流程-技术IP包装全案策划"
EMPTY = "待补充"
SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
DEFAULT_TEMPLATE = SKILL_DIR / "templates" / "ip_pack_plan.md"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a Chinese technology IP packaging plan.")
    parser.add_argument("--input", required=True, help="JSON input file path.")
    parser.add_argument("--output", help="Markdown output file path. Prints to stdout if omitted.")
    parser.add_argument("--template", default=str(DEFAULT_TEMPLATE), help="Markdown template path.")
    return parser.parse_args()


def text(value: Any, default: str = EMPTY) -> str:
    if value is None:
        return default
    if isinstance(value, str):
        return value.strip() or default
    return str(value)


def section(data: dict[str, Any], key: str) -> dict[str, Any]:
    value = data.get(key)
    return value if isinstance(value, dict) else {}


def row_table(value: Any, keys: list[str]) -> str:
    if not isinstance(value, list) or not value:
        return "| " + " | ".join(EMPTY for _ in keys) + " |"

    rows: list[str] = []
    for item in value:
        data = item if isinstance(item, dict) else {}
        rows.append("| " + " | ".join(text(data.get(key)) for key in keys) + " |")
    return "\n".join(rows)


def normalize(data: dict[str, Any]) -> dict[str, str]:
    goals = section(data, "goals")
    insight = section(data, "background_insight")
    user = section(data, "target_user_insight")
    resources = section(data, "resource_assessment")
    architecture = section(data, "product_architecture")
    strategy = section(data, "ip_strategy")
    resource_list = section(data, "resource_list")
    control = section(data, "control_mechanism")

    return {
        "title": text(data.get("title"), DEFAULT_TITLE),
        "tech_ip_name": text(goals.get("tech_ip_name"), text(data.get("tech_ip_name"))),
        "core_positioning": text(goals.get("core_positioning")),
        "short_term_result": text(goals.get("short_term_result")),
        "mid_term_result": text(goals.get("mid_term_result")),
        "long_term_result": text(goals.get("long_term_result")),
        "industry_trend": text(insight.get("industry_trend")),
        "market_competition": text(insight.get("market_competition")),
        "target_user_profile": text(user.get("target_user_profile")),
        "user_core_needs": text(user.get("user_core_needs")),
        "cognitive_barrier": text(user.get("cognitive_barrier")),
        "competitor_ip_rows": row_table(
            data.get("competitor_ips"),
            ["ip", "positioning", "communication_strategy", "learnable_point"],
        ),
        "technology_advantage": text(resources.get("technology_advantage")),
        "brand_assets": text(resources.get("brand_assets")),
        "channel_resources": text(resources.get("channel_resources")),
        "core_layer": text(architecture.get("core_layer")),
        "support_layer": text(architecture.get("support_layer")),
        "application_layer": text(architecture.get("application_layer")),
        "highlight_scenario_rows": row_table(
            data.get("highlight_scenarios"),
            ["scenario", "technology_support", "user_value", "communication_angle"],
        ),
        "model_lock_step_rows": row_table(
            data.get("model_lock_steps"),
            ["stage", "time", "model_node", "ip_action", "brand_action"],
        ),
        "core_narrative": text(strategy.get("core_narrative")),
        "differentiated_positioning": text(strategy.get("differentiated_positioning")),
        "maintenance_strategy": text(strategy.get("maintenance_strategy")),
        "project_role_rows": row_table(
            data.get("project_roles"),
            ["role", "responsibility", "deliverable"],
        ),
        "tech_display": text(resource_list.get("tech_display")),
        "tech_certification": text(resource_list.get("tech_certification")),
        "tech_video": text(resource_list.get("tech_video")),
        "offline_event": text(resource_list.get("offline_event")),
        "other_materials": text(resource_list.get("other_materials")),
        "budget_item_rows": row_table(data.get("budget_items"), ["category", "budget", "note"]),
        "milestone_check": text(control.get("milestone_check")),
        "quality_gate": text(control.get("quality_gate")),
        "risk_plan": text(control.get("risk_plan")),
        "template_version": text(data.get("template_version"), "v1.0"),
        "template_source": text(data.get("template_source"), "附录04"),
    }


def render(template: str, context: dict[str, str]) -> str:
    result = template
    for key, value in context.items():
        result = result.replace("{{" + key + "}}", value)
    return result.rstrip() + "\n"


def main() -> int:
    args = parse_args()
    input_path = Path(args.input)
    template_path = Path(args.template)

    data = json.loads(input_path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("Input JSON must be an object.")

    content = render(template_path.read_text(encoding="utf-8"), normalize(data))
    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(content, encoding="utf-8")
    else:
        print(content, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
