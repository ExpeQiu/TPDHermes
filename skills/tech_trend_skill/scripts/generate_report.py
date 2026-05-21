#!/usr/bin/env python3
"""Generate a technology trend insight report from JSON input.

This script uses only the Python standard library so it can run in restricted
platform environments.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


DEFAULT_TITLE = "技术推广-车型项目管理流程-技术发展/品牌营销洞察报告"
EMPTY = "待补充"
SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
DEFAULT_TEMPLATE = SKILL_DIR / "templates" / "technology_trend_insight_report.md"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a Chinese technology trend insight report.")
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


def bullet_lines(value: Any) -> str:
    return "\n".join(f"  - {item}" for item in list_value(value))


def inline_list(value: Any) -> str:
    return "、".join(list_value(value))


def competitor_rows(value: Any) -> str:
    if not isinstance(value, list) or not value:
        return f"| {EMPTY} | {EMPTY} | {EMPTY} | {EMPTY} |"

    rows: list[str] = []
    for item in value:
        competitor = item if isinstance(item, dict) else {}
        rows.append(
            "| {name} | {strengths} | {weaknesses} | {differentiation} |".format(
                name=text(competitor.get("name")),
                strengths=text(competitor.get("strengths")),
                weaknesses=text(competitor.get("weaknesses")),
                differentiation=text(competitor.get("differentiation")),
            )
        )
    return "\n".join(rows)


def normalize(data: dict[str, Any]) -> dict[str, str]:
    industry = section(data, "industry_analysis")
    market = section(data, "market_analysis")
    internal = section(data, "self_analysis")
    marketing = section(data, "marketing_insight")
    outlook = section(data, "technology_outlook")
    strategy = section(data, "strategy_recommendations")

    return {
        "title": text(data.get("title"), DEFAULT_TITLE),
        "project_name": text(data.get("project_name")),
        "industry": text(data.get("industry")),
        "technology_domain": text(data.get("technology_domain")),
        "report_period": text(data.get("report_period")),
        "macro_environment": text(industry.get("macro_environment")),
        "technology_change_direction": text(industry.get("technology_change_direction")),
        "industry_lifecycle_stage": text(industry.get("lifecycle_stage")),
        "customer_needs": text(market.get("customer_needs")),
        "customer_pain_points": text(market.get("pain_points")),
        "unmet_needs": text(market.get("unmet_needs")),
        "competitor_rows": competitor_rows(data.get("competitors")),
        "resource_capability": text(internal.get("resource_capability")),
        "technology_shortcomings": text(internal.get("technology_shortcomings")),
        "advantage_accumulation": text(internal.get("advantage_accumulation")),
        "strategic_opportunities": bullet_lines(data.get("strategic_opportunities")),
        "opportunity_priorities": bullet_lines(data.get("opportunity_priorities")),
        "industry_technology_features": bullet_lines(marketing.get("industry_technology_features")),
        "communication_directions": bullet_lines(marketing.get("communication_directions")),
        "narrative_logic": text(marketing.get("narrative_logic")),
        "main_channels": inline_list(marketing.get("main_channels")),
        "communication_cadence": text(marketing.get("communication_cadence")),
        "trend_judgement": text(outlook.get("trend_judgement")),
        "time_window": text(outlook.get("time_window")),
        "marketing_positioning": text(strategy.get("marketing_positioning")),
        "promotion_dimensions": inline_list(strategy.get("promotion_dimensions")),
        "channel_strategy": inline_list(strategy.get("channel_strategy")),
        "execution_cadence": bullet_lines(strategy.get("execution_cadence")),
        "template_version": text(data.get("template_version"), "v1.0"),
        "template_source": text(data.get("template_source"), "附录01"),
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
