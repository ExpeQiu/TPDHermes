#!/usr/bin/env python3
"""Generate a technology promotion event plan from JSON input."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


DEFAULT_TITLE = "技术推广活动执行（运营）流程-技术推广活动策划方案"
EMPTY = "待补充"
SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
DEFAULT_TEMPLATE = SKILL_DIR / "templates" / "event_plan.md"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a Chinese technology promotion event plan.")
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


def list_value(value: Any) -> list[str]:
    if value is None:
        return [EMPTY]
    if isinstance(value, list):
        return [text(item) for item in value] or [EMPTY]
    return [text(value)]


def checkbox_lines(value: Any) -> str:
    return "\n".join(f"  - [ ] {item}" for item in list_value(value))


def numbered_lines(value: Any) -> str:
    return "\n".join(f"{index}. {item}" for index, item in enumerate(list_value(value), start=1))


def row_table(value: Any, keys: list[str]) -> str:
    if not isinstance(value, list) or not value:
        return "| " + " | ".join(EMPTY for _ in keys) + " |"

    rows: list[str] = []
    for item in value:
        data = item if isinstance(item, dict) else {}
        rows.append("| " + " | ".join(text(data.get(key)) for key in keys) + " |")
    return "\n".join(rows)


def normalize(data: dict[str, Any]) -> dict[str, str]:
    exhibition = section(data, "exhibition_info")
    strategy = section(data, "strategy")
    goals = section(data, "strategic_goals")
    communication = section(data, "communication_plan")
    booth = section(data, "booth_info")
    schedule = section(data, "schedule")
    nodes = section(data, "key_collaboration_nodes")

    return {
        "title": text(data.get("title"), DEFAULT_TITLE),
        "organizer": text(exhibition.get("organizer")),
        "exhibition_intro": text(exhibition.get("intro")),
        "exhibition_values": checkbox_lines(data.get("exhibition_values")),
        "official_theme": text(exhibition.get("official_theme")),
        "theme_interpretation": text(exhibition.get("theme_interpretation")),
        "exhibition_time": text(exhibition.get("time")),
        "exhibition_address": text(exhibition.get("address")),
        "booth_area_basic": text(exhibition.get("booth_area")),
        "enterprise_alignment": text(strategy.get("enterprise_alignment")),
        "tech_display_value": text(strategy.get("tech_display_value")),
        "business_conversion_value": text(strategy.get("business_conversion_value")),
        "industry_trend_forecast": text(strategy.get("industry_trend_forecast")),
        "competitor_dynamics": text(strategy.get("competitor_dynamics")),
        "hot_topic_forecast": text(strategy.get("hot_topic_forecast")),
        "brand_image_goal": text(goals.get("brand_image_goal")),
        "tech_communication_goal": text(goals.get("tech_communication_goal")),
        "business_conversion_goal": text(goals.get("business_conversion_goal")),
        "quantitative_goal_rows": row_table(data.get("quantitative_goals"), ["metric", "target_value", "measurement_method"]),
        "coverage_goal": text(communication.get("coverage_goal")),
        "interaction_goal": text(communication.get("interaction_goal")),
        "topic_goal": text(communication.get("topic_goal")),
        "compliance_requirement": text(communication.get("compliance_requirement")),
        "competitor_comparison_rule": text(communication.get("competitor_comparison_rule")),
        "sensitive_topic_handling": text(communication.get("sensitive_topic_handling")),
        "booth_location": text(booth.get("location")),
        "booth_area": text(booth.get("area")),
        "booth_design_theme": text(booth.get("design_theme")),
        "booth_zone_rows": row_table(data.get("booth_zones"), ["zone", "function", "core_content"]),
        "tech_highlights": numbered_lines(data.get("tech_highlights")),
        "timeline_rows": row_table(data.get("timeline"), ["time_node", "content", "owner", "completion_standard"]),
        "spokesperson_rows": row_table(data.get("spokespersons"), ["person", "position", "responsible_part", "speech_content"]),
        "media_day": text(schedule.get("media_day")),
        "public_day": text(schedule.get("public_day")),
        "task_assignment_rows": row_table(data.get("task_assignments"), ["department", "responsibility", "core_task", "deliverable"]),
        "kickoff_meeting": text(nodes.get("kickoff_meeting")),
        "material_review": text(nodes.get("material_review")),
        "pre_show_rehearsal": text(nodes.get("pre_show_rehearsal")),
        "onsite_execution": text(nodes.get("onsite_execution")),
        "template_version": text(data.get("template_version"), "v1.0"),
        "template_source": text(data.get("template_source"), "附录15"),
    }


def render(template: str, context: dict[str, str]) -> str:
    result = template
    for key, value in context.items():
        result = result.replace("{{" + key + "}}", value)
    return result.rstrip() + "\n"


def main() -> int:
    args = parse_args()
    data = json.loads(Path(args.input).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("Input JSON must be an object.")

    content = render(Path(args.template).read_text(encoding="utf-8"), normalize(data))
    if args.output:
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(content, encoding="utf-8")
    else:
        print(content, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
