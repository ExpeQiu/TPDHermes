#!/usr/bin/env python3
"""Generate a technology brand strategy and naming report from JSON input."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


DEFAULT_TITLE = "技术品牌策略制定流程-技术品牌策略/命名报告"
EMPTY = "待补充"
SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
DEFAULT_TEMPLATE = SKILL_DIR / "templates" / "brand_name_report.md"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a Chinese technology brand strategy report.")
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


def support_blocks(value: Any) -> str:
    items = value if isinstance(value, list) else []
    if not items:
        items = [{}, {}, {}]

    blocks: list[str] = []
    for index, item in enumerate(items[:3], start=1):
        data = item if isinstance(item, dict) else {}
        blocks.append(
            f"**支撑信息{index}：**\n"
            f"- 信息内容：{text(data.get('content'))}\n"
            f"- 佐证数据：{text(data.get('evidence'))}"
        )
    return "\n\n".join(blocks)


def normalize(data: dict[str, Any]) -> dict[str, str]:
    insight = section(data, "brand_insight")
    strategy = section(data, "brand_strategy")
    message_house = section(data, "core_message_house")

    return {
        "title": text(data.get("title"), DEFAULT_TITLE),
        "industry_trend": text(insight.get("industry_trend")),
        "market_competition": text(insight.get("market_competition")),
        "user_cognition": text(insight.get("user_cognition")),
        "core_highlight": text(insight.get("core_highlight")),
        "market_position": text(insight.get("market_position")),
        "target_interpretation": text(insight.get("target_interpretation")),
        "task_positioning": text(insight.get("task_positioning")),
        "differentiation_opportunity": text(insight.get("differentiation_opportunity")),
        "core_strategy": text(strategy.get("core_strategy")),
        "differentiated_positioning": text(strategy.get("differentiated_positioning")),
        "support_points": text(strategy.get("support_points")),
        "strategy_goal_rows": row_table(data.get("strategy_goals"), ["dimension", "goal", "metric"]),
        "top_message": text(message_house.get("top_message")),
        "support_message_blocks": support_blocks(data.get("support_messages")),
        "key_stage_rows": row_table(
            data.get("key_stages"),
            ["stage", "time_node", "stage_goal", "key_message", "key_action"],
        ),
        "model_launch_binding_rows": row_table(
            data.get("model_launch_bindings"),
            ["model", "release_time", "brand_action", "communication_focus"],
        ),
        "template_version": text(data.get("template_version"), "v1.0"),
        "template_source": text(data.get("template_source"), "附录09"),
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
