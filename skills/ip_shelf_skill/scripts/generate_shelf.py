#!/usr/bin/env python3
"""Generate a technology IP shelf document from JSON input."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


DEFAULT_TITLE = "技术品牌（IP）包装流程-技术IP包装货架文档"
EMPTY = "待补充"
SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
DEFAULT_TEMPLATE = SKILL_DIR / "templates" / "ip_shelf_doc.md"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a Chinese technology IP shelf document.")
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


def tech_outline(value: Any) -> str:
    if not isinstance(value, list) or not value:
        return "1. **核心技术1：待补充**\n   - 技术原理：待补充\n   - 性能指标：待补充"

    blocks: list[str] = []
    for index, item in enumerate(value, start=1):
        data = item if isinstance(item, dict) else {}
        blocks.append(
            f"{index}. **核心技术{index}：{text(data.get('name'))}**\n"
            f"   - 技术原理：{text(data.get('principle'))}\n"
            f"   - 性能指标：{text(data.get('metric'))}"
        )
    return "\n".join(blocks)


def normalize(data: dict[str, Any]) -> dict[str, str]:
    target_user = section(data, "target_user")
    industry = section(data, "industry_scan")
    vision = section(data, "vision")
    positioning = section(data, "positioning")
    user_value = section(data, "user_value")

    return {
        "title": text(data.get("title"), DEFAULT_TITLE),
        "user_group": text(target_user.get("user_group")),
        "use_scenario": text(target_user.get("use_scenario")),
        "core_appeal": text(target_user.get("core_appeal")),
        "need_match_rows": row_table(data.get("need_matches"), ["user_need", "matched_tech", "differentiation"]),
        "stage": text(industry.get("stage")),
        "influence_assessment": text(industry.get("influence_assessment")),
        "comparison_rows": row_table(
            data.get("comparison"),
            ["dimension", "ours", "competitor_a", "competitor_b", "competitor_c"],
        ),
        "slogan": text(data.get("slogan"), "一句话核心主张（建议8-15字）"),
        "technology_vision": text(vision.get("technology_vision")),
        "brand_vision": text(vision.get("brand_vision")),
        "user_vision": text(vision.get("user_vision")),
        "positioning_description": text(positioning.get("description")),
        "positioning_support_points": text(positioning.get("support_points")),
        "functional_value": text(user_value.get("functional_value")),
        "emotional_value": text(user_value.get("emotional_value")),
        "symbolic_value": text(user_value.get("symbolic_value")),
        "tech_outline": tech_outline(data.get("tech_outline")),
        "model_match_rows": row_table(data.get("model_matches"), ["model", "status", "scenario"]),
        "better_point_rows": row_table(data.get("better_points"), ["tech_point", "advantage", "metric", "evidence"]),
        "unique_point_rows": row_table(data.get("unique_points"), ["tech_point", "exclusive_advantage", "barrier", "launch_time"]),
        "scenario_info_rows": row_table(data.get("scenario_info"), ["scenario", "pain_point", "solution", "promotion_angle"]),
        "template_version": text(data.get("template_version"), "v1.0"),
        "template_source": text(data.get("template_source"), "附录05"),
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
