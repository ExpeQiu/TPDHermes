#!/usr/bin/env python3
"""Generate a model technology brand strategy document from JSON input."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


DEFAULT_TITLE = "技术推广-车型项目管理流程-技术品牌赋能车型策略方案"
EMPTY = "待补充"
SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
DEFAULT_TEMPLATE = SKILL_DIR / "templates" / "model_brand_strategy.md"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a Chinese model brand strategy document.")
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
    items = list_value(value)
    return "\n".join(f"- 亮点{index}：{item}" for index, item in enumerate(items, start=1))


def row_table(value: Any, columns: list[tuple[str, str]]) -> str:
    if not isinstance(value, list) or not value:
        return "| " + " | ".join(EMPTY for _ in columns) + " |"

    rows: list[str] = []
    for item in value:
        data = item if isinstance(item, dict) else {}
        rows.append("| " + " | ".join(text(data.get(key)) for key, _ in columns) + " |")
    return "\n".join(rows)


def normalize(data: dict[str, Any]) -> dict[str, str]:
    ip_source = section(data, "tech_ip_source")
    model = section(data, "model_info")
    linkage = section(data, "ip_linkage")
    strategy = section(data, "core_strategy")
    issues = section(data, "key_issue_responses")

    return {
        "title": text(data.get("title"), DEFAULT_TITLE),
        "tech_ip_definition": text(ip_source.get("definition")),
        "brand_value_rule": text(ip_source.get("brand_value_rule")),
        "model_name": text(model.get("model_name"), text(data.get("model_name"))),
        "model_positioning": text(model.get("model_positioning"), text(data.get("model_positioning"))),
        "product_power_mix": text(model.get("product_power_mix"), text(data.get("product_power_mix"))),
        "tech_ip_focus_rows": row_table(
            data.get("tech_ip_focus"),
            [
                ("ip", "技术IP"),
                ("empower_direction", "赋能方向"),
                ("focus_note", "侧重点说明"),
            ],
        ),
        "overall_empower_direction": text(linkage.get("overall_empower_direction")),
        "ip_relationship": text(linkage.get("ip_relationship")),
        "core_concept": text(strategy.get("core_concept")),
        "ip_hierarchy": text(strategy.get("ip_hierarchy")),
        "synergy_logic": text(strategy.get("synergy_logic")),
        "supporting_info_rows": row_table(
            data.get("supporting_info"),
            [
                ("dimension", "支撑维度"),
                ("info", "具体信息"),
                ("evidence", "佐证数据"),
            ],
        ),
        "highlights": numbered_lines(data.get("highlights")),
        "config_inversion_issue": text(issues.get("config_inversion_issue")),
        "config_inversion_response": text(issues.get("config_inversion_response")),
        "naming_issue": text(issues.get("naming_issue")),
        "naming_response": text(issues.get("naming_response")),
        "sensitive_issue_rows": row_table(
            data.get("sensitive_issues"),
            [
                ("issue", "问题"),
                ("risk_level", "风险等级"),
                ("response", "回应策略"),
            ],
        ),
        "template_version": text(data.get("template_version"), "v1.0"),
        "template_source": text(data.get("template_source"), "附录02"),
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
