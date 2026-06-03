#!/usr/bin/env python3
"""Generate an IP technology display user guide from JSON input."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


DEFAULT_TITLE = "IP技术展具制作流程-IP技术展具使用说明书"
EMPTY = "待补充"
SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
DEFAULT_TEMPLATE = SKILL_DIR / "templates" / "display_guide.md"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a Chinese IP display user guide.")
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


def normalize(data: dict[str, Any]) -> dict[str, str]:
    basic = section(data, "basic_info")
    params = section(data, "technical_params")
    fire = section(data, "fire_safety")
    height = section(data, "height_limit")
    load = section(data, "load_limit")
    electrical = section(data, "electrical_safety")
    assembly = section(data, "assembly")
    dismantle = section(data, "dismantle")
    usage = section(data, "usage_rules")
    storage = section(data, "storage")
    care = section(data, "care")

    return {
        "title": text(data.get("title"), DEFAULT_TITLE),
        "display_id": text(basic.get("display_id")),
        "display_type": text(basic.get("display_type")),
        "core_function": text(basic.get("core_function")),
        "applicable_scenario": text(basic.get("applicable_scenario")),
        "accessories": text(basic.get("accessories")),
        "size": text(params.get("size")),
        "weight": text(params.get("weight")),
        "power_requirement": text(params.get("power_requirement")),
        "setup_requirement": text(params.get("setup_requirement")),
        "flame_retardant_level": text(fire.get("flame_retardant_level")),
        "forbidden_materials": text(fire.get("forbidden_materials")),
        "extinguisher_requirement": text(fire.get("extinguisher_requirement")),
        "max_height": text(height.get("max_height")),
        "floor_height_requirement": text(height.get("floor_height_requirement")),
        "max_load": text(load.get("max_load")),
        "point_load_limit": text(load.get("point_load_limit")),
        "power_limit": text(electrical.get("power_limit")),
        "grounding_requirement": text(electrical.get("grounding_requirement")),
        "waterproof_level": text(electrical.get("waterproof_level")),
        "transport_note_rows": row_table(data.get("transport_notes"), ["stage", "requirement", "responsible_party"]),
        "pre_check": text(assembly.get("pre_check")),
        "floor_treatment": text(assembly.get("floor_treatment")),
        "main_setup_order": text(assembly.get("main_setup_order")),
        "electrical_wiring": text(assembly.get("electrical_wiring")),
        "debug_test": text(assembly.get("debug_test")),
        "exhibit_display": text(assembly.get("exhibit_display")),
        "acceptance": text(assembly.get("acceptance")),
        "power_off_confirm": text(dismantle.get("power_off_confirm")),
        "dismantle_order": text(dismantle.get("dismantle_order")),
        "packing_storage": text(dismantle.get("packing_storage")),
        "exit_handover": text(dismantle.get("exit_handover")),
        "daily_start": text(usage.get("daily_start")),
        "daily_usage": text(usage.get("daily_usage")),
        "daily_shutdown": text(usage.get("daily_shutdown")),
        "fixture_method_rows": row_table(data.get("fixture_methods"), ["exhibit", "fixture_method", "tool_requirement"]),
        "temperature_humidity": text(storage.get("temperature_humidity")),
        "stacking_rule": text(storage.get("stacking_rule")),
        "protection_requirement": text(storage.get("protection_requirement")),
        "cleaning_frequency": text(care.get("cleaning_frequency")),
        "cleaning_method": text(care.get("cleaning_method")),
        "wear_part_check": text(care.get("wear_part_check")),
        "troubleshooting_rows": row_table(data.get("troubleshooting"), ["fault_type", "handling_method", "emergency_contact"]),
        "template_version": text(data.get("template_version"), "v1.0"),
        "template_source": text(data.get("template_source"), "附录08"),
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
