#!/usr/bin/env python3
"""Generate an IP technology display concept plan from JSON input."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


DEFAULT_TITLE = "IP技术展具制作流程-IP技术展具概念策划书"
EMPTY = "待补充"
SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
DEFAULT_TEMPLATE = SKILL_DIR / "templates" / "display_concept.md"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a Chinese IP display concept plan.")
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
    return "\n".join(f"{index}. {item}" for index, item in enumerate(list_value(value), start=1))


def bullet_lines(value: Any) -> str:
    return "\n".join(f"- 核心亮点{index}：{item}" for index, item in enumerate(list_value(value), start=1))


def row_table(value: Any, keys: list[str]) -> str:
    if not isinstance(value, list) or not value:
        return "| " + " | ".join(EMPTY for _ in keys) + " |"

    rows: list[str] = []
    for item in value:
        data = item if isinstance(item, dict) else {}
        rows.append("| " + " | ".join(text(data.get(key)) for key in keys) + " |")
    return "\n".join(rows)


def normalize(data: dict[str, Any]) -> dict[str, str]:
    basic = section(data, "basic_info")
    maintenance = section(data, "maintenance")
    cycle = section(data, "production_cycle")

    return {
        "title": text(data.get("title"), DEFAULT_TITLE),
        "display_name": text(basic.get("display_name"), text(data.get("display_name"))),
        "display_type": text(basic.get("display_type")),
        "venue": text(basic.get("venue")),
        "duration": text(basic.get("duration")),
        "concept_summary": text(data.get("concept_summary")),
        "show_dimensions": numbered_lines(data.get("show_dimensions")),
        "benchmark_case_rows": row_table(data.get("benchmark_cases"), ["case", "highlight", "learnable_point"]),
        "highlight_features": bullet_lines(data.get("highlight_features")),
        "principle_description": text(data.get("principle_description")),
        "detail_point_rows": row_table(data.get("detail_points"), ["part", "show_point", "material_requirement"]),
        "diagram_note": text(data.get("diagram_note"), "[在此贴图或描述关键结构]"),
        "maintenance_requirement": text(maintenance.get("maintenance_requirement")),
        "transport_rule": text(maintenance.get("transport_rule")),
        "storage_condition": text(maintenance.get("storage_condition")),
        "budget_item_rows": row_table(data.get("budget_items"), ["item", "amount", "note"]),
        "concept_planning": text(cycle.get("concept_planning")),
        "design_drawing": text(cycle.get("design_drawing")),
        "prototype": text(cycle.get("prototype")),
        "acceptance": text(cycle.get("acceptance")),
        "total_cycle": text(cycle.get("total_cycle")),
        "template_version": text(data.get("template_version"), "v1.0"),
        "template_source": text(data.get("template_source"), "附录06"),
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
