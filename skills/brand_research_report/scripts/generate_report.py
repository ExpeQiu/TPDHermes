#!/usr/bin/env python3
"""Generate a technology brand research report from JSON input."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


DEFAULT_TITLE = "技术品牌调研流程-技术品牌调研报告"
EMPTY = "待补充"
SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
DEFAULT_TEMPLATE = SKILL_DIR / "templates" / "research_report.md"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a Chinese technology brand research report.")
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


def conclusion_lines(value: Any) -> str:
    return "\n".join(f"- 结论{index}：{item}" for index, item in enumerate(list_value(value), start=1))


def row_table(value: Any, keys: list[str]) -> str:
    if not isinstance(value, list) or not value:
        return "| " + " | ".join(EMPTY for _ in keys) + " |"

    rows: list[str] = []
    for item in value:
        data = item if isinstance(item, dict) else {}
        rows.append("| " + " | ".join(text(data.get(key)) for key in keys) + " |")
    return "\n".join(rows)


def finding_blocks(value: Any) -> str:
    items = value if isinstance(value, list) else []
    if not items:
        items = [{}, {}, {}, {}]

    blocks: list[str] = []
    for index, item in enumerate(items[:4], start=1):
        data = item if isinstance(item, dict) else {}
        blocks.append(
            f"### 发现{index}：{text(data.get('theme'), '[主题]')}\n"
            f"- 数据/事实：{text(data.get('fact'))}\n"
            f"- 分析解读：{text(data.get('analysis'))}\n"
            f"- 置信度：{text(data.get('confidence'), '□高  □中  □低')}"
        )
    return "\n\n".join(blocks)


def normalize(data: dict[str, Any]) -> dict[str, str]:
    background = section(data, "background")
    execution = section(data, "execution")
    notes = section(data, "report_notes")
    appendix = section(data, "appendix")

    return {
        "title": text(data.get("title"), DEFAULT_TITLE),
        "start_background": text(background.get("start_background")),
        "research_purpose": text(background.get("research_purpose")),
        "questions_to_solve": text(background.get("questions_to_solve")),
        "execution_time": text(execution.get("time")),
        "execution_cities": text(execution.get("cities")),
        "execution_methods": text(execution.get("methods")),
        "valid_samples": text(execution.get("valid_samples")),
        "calculation_method": text(notes.get("calculation_method")),
        "metric_definition": text(notes.get("metric_definition")),
        "structure_note": text(notes.get("structure_note")),
        "core_viewpoints": numbered_lines(data.get("core_viewpoints")),
        "key_conclusions": conclusion_lines(data.get("key_conclusions")),
        "recommended_action_rows": row_table(data.get("recommended_actions"), ["priority", "recommendation", "owner", "time_node"]),
        "finding_blocks": finding_blocks(data.get("findings")),
        "strategy_suggestions": numbered_lines(data.get("strategy_suggestions")),
        "execution_suggestion_rows": row_table(data.get("execution_suggestions"), ["suggestion", "precondition", "expected_effect"]),
        "data_tables": text(appendix.get("data_tables"), "[附件形式提供]"),
        "questionnaire": text(appendix.get("questionnaire"), "[附件形式提供]"),
        "records": text(appendix.get("records"), "[附件形式提供]"),
        "template_version": text(data.get("template_version"), "v1.0"),
        "template_source": text(data.get("template_source"), "附录11"),
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
