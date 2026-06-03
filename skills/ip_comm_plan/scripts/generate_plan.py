#!/usr/bin/env python3
"""Generate a technology IP communication plan from JSON input."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


DEFAULT_TITLE = "技术IP生态运营（传播）流程-技术IP传播策划方案"
EMPTY = "待补充"
SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
DEFAULT_TEMPLATE = SKILL_DIR / "templates" / "ip_comm_plan.md"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a Chinese technology IP communication plan.")
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


def smart_lines(value: Any) -> str:
    if isinstance(value, list):
        items = [text(item) for item in value]
    elif isinstance(value, dict):
        items = [f"{key}：{text(val)}" for key, val in value.items()]
    else:
        items = ["Specific（具体）", "Measurable（可衡量）", "Achievable（可实现）", "Relevant（相关性）", "Time-bound（有时限）"]
    return "\n".join(f"  - [ ] {item}" for item in items)


def row_table(value: Any, keys: list[str]) -> str:
    if not isinstance(value, list) or not value:
        return "| " + " | ".join(EMPTY for _ in keys) + " |"

    rows: list[str] = []
    for item in value:
        data = item if isinstance(item, dict) else {}
        rows.append("| " + " | ".join(text(data.get(key)) for key in keys) + " |")
    return "\n".join(rows)


def normalize(data: dict[str, Any]) -> dict[str, str]:
    background = section(data, "project_background")
    goal = section(data, "core_goal")
    budget_cycle = section(data, "budget_cycle")
    strategy = section(data, "strategy")
    stage_details = section(data, "stage_details")
    warmup = section(stage_details, "warmup")
    burst = section(stage_details, "burst")
    sustain = section(stage_details, "sustain")

    return {
        "title": text(data.get("title"), DEFAULT_TITLE),
        "industry_trend": text(background.get("industry_trend")),
        "market_competition": text(background.get("market_competition")),
        "start_reason": text(background.get("start_reason")),
        "goal_one_sentence": text(goal.get("one_sentence"), "一句话概括本次传播的终极目的"),
        "goal_description": text(goal.get("description")),
        "smart_check": smart_lines(goal.get("smart_check")),
        "key_message": text(data.get("key_message"), "本次传播最希望目标用户记住的一句话"),
        "total_budget_range": text(budget_cycle.get("total_budget_range")),
        "core_cycle": text(budget_cycle.get("core_cycle")),
        "communication_goal_rows": row_table(data.get("communication_goals"), ["dimension", "metric", "note"]),
        "overall_path": text(strategy.get("overall_path")),
        "message_line": text(strategy.get("message_line")),
        "audience_segment_rows": row_table(data.get("audience_segments"), ["audience", "core_need", "channel", "message_angle"]),
        "content_plan_rows": row_table(data.get("content_plan"), ["content_type", "core_content", "target_audience", "channel"]),
        "channel_plan_rows": row_table(data.get("channel_plan"), ["channel", "content_format", "matched_content", "execution_point"]),
        "roadmap_rows": row_table(data.get("roadmap"), ["stage", "time", "stage_goal", "core_action"]),
        "warmup_period": text(warmup.get("period"), "X月X日-X月X日"),
        "warmup_goal": text(warmup.get("goal")),
        "warmup_format": text(warmup.get("format")),
        "warmup_key_content": text(warmup.get("key_content")),
        "burst_period": text(burst.get("period"), "X月X日-X月X日"),
        "burst_goal": text(burst.get("goal")),
        "burst_format": text(burst.get("format")),
        "burst_key_content": text(burst.get("key_content")),
        "sustain_period": text(sustain.get("period"), "X月X日-X月X日"),
        "sustain_goal": text(sustain.get("goal")),
        "sustain_format": text(sustain.get("format")),
        "sustain_key_content": text(sustain.get("key_content")),
        "budget_item_rows": row_table(data.get("budget_items"), ["category", "detail", "amount", "ratio"]),
        "evaluation_metric_rows": row_table(data.get("evaluation_metrics"), ["metric", "expected_value", "measurement_method"]),
        "template_version": text(data.get("template_version"), "v1.0"),
        "template_source": text(data.get("template_source"), "附录12"),
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
