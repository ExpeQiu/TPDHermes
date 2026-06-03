#!/usr/bin/env python3
"""Generate a technology brand research plan from JSON input."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


DEFAULT_TITLE = "技术品牌调研流程-技术品牌调研计划"
EMPTY = "待补充"
SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
DEFAULT_TEMPLATE = SKILL_DIR / "templates" / "research_plan.md"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a Chinese technology brand research plan.")
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


def numbered_lines(value: Any) -> str:
    return "\n".join(f"  - 问题{index}：{item}" for index, item in enumerate(list_value(value), start=1))


def plain_numbered(value: Any) -> str:
    return "\n".join(f"{index}. {item}" for index, item in enumerate(list_value(value), start=1))


def checkbox_lines(value: Any) -> str:
    return "\n".join(f"- □{item}" for item in list_value(value))


def row_table(value: Any, keys: list[str]) -> str:
    if not isinstance(value, list) or not value:
        return "| " + " | ".join(EMPTY for _ in keys) + " |"

    rows: list[str] = []
    for item in value:
        data = item if isinstance(item, dict) else {}
        rows.append("| " + " | ".join(text(data.get(key)) for key in keys) + " |")
    return "\n".join(rows)


def normalize(data: dict[str, Any]) -> dict[str, str]:
    background = section(data, "background")
    purpose = section(data, "purpose")
    sample = section(data, "sample_plan")
    respondents = section(data, "respondent_requirements")
    supplier = section(data, "supplier_requirements")
    supplier_qualification = section(supplier, "qualification")
    supplier_team = section(supplier, "team")
    budget = section(data, "budget_scale")

    return {
        "title": text(data.get("title"), DEFAULT_TITLE),
        "industry_trend": text(background.get("industry_trend")),
        "strategy_need": text(background.get("strategy_need")),
        "research_trigger": text(background.get("research_trigger")),
        "core_questions": numbered_lines(purpose.get("core_questions")),
        "quantitative_goal": text(purpose.get("quantitative_goal")),
        "strategy_output_expectation": text(purpose.get("strategy_output_expectation")),
        "research_method_rows": row_table(data.get("research_methods"), ["method", "scenario", "sample_size", "cycle"]),
        "research_contents": plain_numbered(data.get("research_contents")),
        "target_users": checkbox_lines(sample.get("target_users")),
        "segments": text(sample.get("segments")),
        "region_coverage_rows": row_table(data.get("region_coverage"), ["region", "city", "sample_size"]),
        "entry_criteria": text(respondents.get("entry_criteria")),
        "exclusion_criteria": text(respondents.get("exclusion_criteria")),
        "quota_requirements": text(respondents.get("quota_requirements")),
        "business_scope": text(supplier_qualification.get("business_scope")),
        "experience_years": text(supplier_qualification.get("experience_years")),
        "project_cases": text(supplier_qualification.get("project_cases")),
        "project_leader": text(supplier_team.get("project_leader")),
        "supervisor_qualification": text(supplier_team.get("supervisor_qualification")),
        "interviewer_requirements": text(supplier_team.get("interviewer_requirements")),
        "execution_plan_rows": row_table(data.get("execution_plan"), ["stage", "time", "milestone"]),
        "total_range": text(budget.get("total_range")),
        "budget_ceiling": text(budget.get("budget_ceiling")),
        "budget_allocation_rows": row_table(data.get("budget_allocation"), ["item", "ratio", "note"]),
        "template_version": text(data.get("template_version"), "v1.0"),
        "template_source": text(data.get("template_source"), "附录10"),
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
