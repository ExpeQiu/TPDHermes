#!/usr/bin/env python3
"""Generate a technology planning and brand lock-map document from JSON input."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


DEFAULT_TITLE = "技术推广-车型项目管理流程-技术规划与技术品牌互锁地图"
EMPTY = "待补充"
SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
DEFAULT_TEMPLATE = SKILL_DIR / "templates" / "tech_lockmap.md"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a Chinese technology and brand lock-map.")
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


def list_value(value: Any) -> list[str]:
    if value is None:
        return [
            "技术节点与车型节奏已对齐",
            "品牌传播节点与工程节点已匹配",
            "用户触点覆盖完整",
            "各部门已确认协同责任",
        ]
    if isinstance(value, list):
        return [text(item) for item in value] or [EMPTY]
    return [text(value)]


def checklist_lines(value: Any) -> str:
    return "\n".join(f"- [ ] {item}" for item in list_value(value))


def row_table(value: Any, keys: list[str]) -> str:
    if not isinstance(value, list) or not value:
        return "| " + " | ".join(EMPTY for _ in keys) + " |"

    rows: list[str] = []
    for item in value:
        data = item if isinstance(item, dict) else {}
        rows.append("| " + " | ".join(text(data.get(key)) for key in keys) + " |")
    return "\n".join(rows)


def normalize(data: dict[str, Any]) -> dict[str, str]:
    return {
        "title": text(data.get("title"), DEFAULT_TITLE),
        "technology_node_rows": row_table(
            data.get("technology_nodes"),
            ["time_node", "milestone", "model", "brand_binding"],
        ),
        "model_timeline_rows": row_table(
            data.get("model_timeline"),
            ["model", "launch_time", "technology", "brand_focus"],
        ),
        "brand_action_rows": row_table(
            data.get("brand_actions"),
            ["action", "linked_tech_node", "target_touchpoint"],
        ),
        "user_touchpoint_rows": row_table(
            data.get("user_touchpoints"),
            ["touchpoint", "tech_message", "brand_tone", "channel"],
        ),
        "checklist": checklist_lines(data.get("checklist")),
        "template_version": text(data.get("template_version"), "v1.0"),
        "template_source": text(data.get("template_source"), "附录03"),
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
