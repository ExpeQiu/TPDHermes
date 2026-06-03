#!/usr/bin/env python3
"""Generate a leadership speech draft from JSON input."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


DEFAULT_TITLE = "技术推广内容制作流程-领导讲稿"
EMPTY = "待补充"
SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
DEFAULT_TEMPLATE = SKILL_DIR / "templates" / "speech_draft.md"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a Chinese leadership speech draft.")
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


def pillar_blocks(value: Any) -> str:
    items = value if isinstance(value, list) else []
    if not items:
        items = [{}, {}, {}]

    blocks: list[str] = []
    for index, item in enumerate(items[:3], start=1):
        data = item if isinstance(item, dict) else {}
        blocks.append(
            f"**技术支柱{index}：{text(data.get('name'), '[名称]')}**\n"
            f"- 核心原理：{text(data.get('principle'))}\n"
            f"- 性能数据：{text(data.get('data'))}\n"
            f"- 用户价值：{text(data.get('user_value'))}"
        )
    return "\n\n".join(blocks)


def normalize(data: dict[str, Any]) -> dict[str, str]:
    opening = section(data, "opening")
    pain = section(data, "pain_points")
    vision = section(data, "vision")
    technology = section(data, "technology")
    promise = section(data, "promise")
    closing = section(data, "closing")

    return {
        "title": text(data.get("title"), DEFAULT_TITLE),
        "greeting": text(opening.get("greeting"), "[标准问候语，根据场合调整]"),
        "technology_trend": text(opening.get("technology_trend")),
        "market_change": text(opening.get("market_change")),
        "user_need_evolution": text(opening.get("user_need_evolution")),
        "core_announcement": text(opening.get("core_announcement")),
        "tech_name": text(opening.get("tech_name"), "[此处填入核心技术名称/品牌]"),
        "value_proposition": text(opening.get("value_proposition"), "[此处填入核心价值主张]"),
        "safety_anxiety": text(pain.get("safety_anxiety")),
        "range_anxiety": text(pain.get("range_anxiety")),
        "homogenization": text(pain.get("homogenization")),
        "other_pain": text(pain.get("other")),
        "solution_to_pain": text(vision.get("solution_to_pain")),
        "core_idea": text(vision.get("core_idea")),
        "system_name": text(technology.get("system_name"), "技术品牌名称或体系名称"),
        "pillar_blocks": pillar_blocks(data.get("pillars")),
        "scenario_value_rows": row_table(data.get("scenario_values"), ["scenario", "tech_enablement", "experience_improvement"]),
        "technology_reliability": text(promise.get("technology_reliability")),
        "safety_standard": text(promise.get("safety_standard")),
        "upgrade_commitment": text(promise.get("upgrade_commitment")),
        "summary": text(closing.get("summary")),
        "partners_ecosystem": text(closing.get("partners_ecosystem")),
        "open_commitment": text(closing.get("open_commitment")),
        "ecosystem_vision": text(closing.get("ecosystem_vision")),
        "call_to_action": text(closing.get("call_to_action"), "[核心号召语句]"),
        "next_preview": text(closing.get("next_preview")),
        "thanks_to": text(closing.get("thanks_to")),
        "ending": text(closing.get("ending")),
        "template_version": text(data.get("template_version"), "v1.0"),
        "template_source": text(data.get("template_source"), "附录16"),
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
