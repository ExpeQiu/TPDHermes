#!/usr/bin/env python3
"""Generate an IP technology display project proposal from JSON input."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


DEFAULT_TITLE = "IP技术展具制作流程-IP技术展具制作立项书"
EMPTY = "待补充"
SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
DEFAULT_TEMPLATE = SKILL_DIR / "templates" / "display_project.md"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a Chinese IP display project proposal.")
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
    exhibition = section(data, "exhibition")
    value = section(data, "value")
    gains = section(data, "expected_gains")
    alignment = section(data, "strategy_alignment")
    positioning = section(data, "display_positioning")
    zone = section(data, "zone_style")
    layout = section(data, "layout")
    interaction = section(data, "interaction_design")
    total_budget = section(data, "total_budget")

    return {
        "title": text(data.get("title"), DEFAULT_TITLE),
        "exhibition_name": text(exhibition.get("name")),
        "organizer": text(exhibition.get("organizer")),
        "exhibition_positioning": text(exhibition.get("positioning")),
        "exhibition_time": text(exhibition.get("time")),
        "exhibition_location": text(exhibition.get("location")),
        "strategic_value": text(value.get("strategic_value")),
        "brand_value": text(value.get("brand_value")),
        "business_value": text(value.get("business_value")),
        "short_term_gain": text(gains.get("short_term")),
        "mid_term_gain": text(gains.get("mid_term")),
        "long_term_gain": text(gains.get("long_term")),
        "group_strategy": text(alignment.get("group_strategy")),
        "tech_integration_strategy": text(alignment.get("tech_integration_strategy")),
        "display_goal": text(positioning.get("display_goal")),
        "target_audience": text(positioning.get("target_audience")),
        "differentiation": text(positioning.get("differentiation")),
        "highlight_plan_rows": row_table(data.get("highlight_plan"), ["highlight", "technology_support", "display_method"]),
        "display_logic": text(data.get("display_logic")),
        "area": text(zone.get("area")),
        "style_tone": text(zone.get("style_tone")),
        "color_rule": text(zone.get("color_rule")),
        "entrance": text(layout.get("entrance")),
        "core_area": text(layout.get("core_area")),
        "interactive_area": text(layout.get("interactive_area")),
        "exit": text(layout.get("exit")),
        "technical_highlight_rows": row_table(data.get("technical_highlights"), ["highlight", "description", "material_spec"]),
        "interaction_form": text(interaction.get("interaction_form")),
        "interaction_flow": text(interaction.get("interaction_flow")),
        "technical_support": text(interaction.get("technical_support")),
        "budget_detail_rows": row_table(data.get("budget_details"), ["category", "item", "unit_price", "quantity", "total_price"]),
        "design_fee": text(total_budget.get("design_fee")),
        "production_fee": text(total_budget.get("production_fee")),
        "transport_fee": text(total_budget.get("transport_fee")),
        "maintenance_fee": text(total_budget.get("maintenance_fee")),
        "total_budget": text(total_budget.get("total")),
        "template_version": text(data.get("template_version"), "v1.0"),
        "template_source": text(data.get("template_source"), "附录07"),
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
