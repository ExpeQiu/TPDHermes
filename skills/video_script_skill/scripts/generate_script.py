#!/usr/bin/env python3
"""Generate a technology promotion video director script from JSON input."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


DEFAULT_TITLE = "技术推广视频制作流程-技术推广视频策划/创意/导演脚本"
EMPTY = "待补充"
SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
DEFAULT_TEMPLATE = SKILL_DIR / "templates" / "video_script.md"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a Chinese technology promotion video script.")
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


def row_table(value: Any, keys: list[str], minimum: int = 1) -> str:
    items = value if isinstance(value, list) else []
    if not items:
        items = [{} for _ in range(minimum)]

    rows: list[str] = []
    for item in items:
        data = item if isinstance(item, dict) else {}
        rows.append("| " + " | ".join(text(data.get(key)) for key in keys) + " |")
    return "\n".join(rows)


def storyboard_rows(value: Any) -> str:
    items = value if isinstance(value, list) else []
    if not items:
        items = [{"shot_no": f"{index:02d}"} for index in range(1, 11)]

    rows: list[str] = []
    for index, item in enumerate(items, start=1):
        data = item if isinstance(item, dict) else {}
        rows.append(
            "| {shot_no} | {visual} | {duration} | {sound} | {line} | {shot_type} | {scene_size} | {note} |".format(
                shot_no=text(data.get("shot_no"), f"{index:02d}"),
                visual=text(data.get("visual")),
                duration=text(data.get("duration")),
                sound=text(data.get("sound")),
                line=text(data.get("line")),
                shot_type=text(data.get("shot_type")),
                scene_size=text(data.get("scene_size")),
                note=text(data.get("note")),
            )
        )
    return "\n".join(rows)


def normalize(data: dict[str, Any]) -> dict[str, str]:
    project = section(data, "project_info")
    creative = section(data, "creative")
    collaboration = section(data, "collaboration_notes")

    return {
        "title": text(data.get("title"), DEFAULT_TITLE),
        "project_name": text(project.get("project_name")),
        "video_type": text(project.get("video_type")),
        "duration": text(project.get("duration")),
        "resolution": text(project.get("resolution"), "____"),
        "frame_rate": text(project.get("frame_rate"), "____"),
        "bitrate": text(project.get("bitrate"), "____"),
        "core_theme": text(project.get("core_theme")),
        "core_appeal": text(project.get("core_appeal")),
        "creative_main_line": text(creative.get("main_line")),
        "creative_highlight": text(creative.get("highlight")),
        "creative_tone": text(creative.get("tone")),
        "cg_story": text(creative.get("cg_story"), "[描述虚拟世界观、叙事逻辑]"),
        "live_story": text(creative.get("live_story"), "[描述现实故事线、情感曲线]"),
        "storyboard_rows": storyboard_rows(data.get("storyboards")),
        "technical_requirement_rows": row_table(data.get("technical_requirements"), ["item", "requirement", "owner"]),
        "preparation": text(collaboration.get("preparation")),
        "production_coordination": text(collaboration.get("production_coordination")),
        "post_delivery": text(collaboration.get("post_delivery")),
        "revision_note_rows": row_table(data.get("revision_notes"), ["version", "date", "change", "approver"]),
        "template_version": text(data.get("template_version"), "v1.0"),
        "template_source": text(data.get("template_source"), "附录13"),
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
