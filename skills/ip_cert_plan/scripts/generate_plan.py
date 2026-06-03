#!/usr/bin/env python3
"""Generate an IP technology certification plan from JSON input."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


DEFAULT_TITLE = "IP技术认证流程-IP技术认证策划方案"
EMPTY = "待补充"
SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
DEFAULT_TEMPLATE = SKILL_DIR / "templates" / "ip_cert_plan.md"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a Chinese IP certification plan.")
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
    background = section(data, "background_value")
    purpose = section(data, "certification_purpose")
    schedule = section(data, "test_schedule")
    rights = section(data, "communication_rights")

    return {
        "title": text(data.get("title"), DEFAULT_TITLE),
        "tech_ip_background": text(background.get("tech_ip_background")),
        "certification_necessity": text(background.get("certification_necessity")),
        "brand_endorsement": text(background.get("brand_endorsement")),
        "user_trust": text(background.get("user_trust")),
        "competitor_differentiation": text(background.get("competitor_differentiation")),
        "core_purpose": text(purpose.get("core_purpose")),
        "expected_result": text(purpose.get("expected_result")),
        "application_scenarios": text(purpose.get("application_scenarios")),
        "test_subject_rows": row_table(data.get("test_subjects"), ["subject", "tech_selling_point", "test_method", "evaluation_standard"]),
        "test_rule_rows": row_table(data.get("test_rules"), ["subject", "test_method", "value_requirement", "pass_standard"]),
        "test_time": text(schedule.get("test_time")),
        "test_location": text(schedule.get("test_location")),
        "site_requirement": text(schedule.get("site_requirement")),
        "support_staff": text(schedule.get("support_staff")),
        "video_resource_rows": row_table(data.get("video_resources"), ["video_type", "content_requirement", "production_cycle", "owner"]),
        "communication_resource_rows": row_table(data.get("communication_resources"), ["channel", "content_format", "communication_time", "owner"]),
        "result_usage_scope": text(rights.get("result_usage_scope")),
        "media_release_rights": text(rights.get("media_release_rights")),
        "official_communication_rights": text(rights.get("official_communication_rights")),
        "quotation_item_rows": row_table(data.get("quotation_items"), ["category", "detail", "unit_price", "quantity", "total_price"]),
        "template_version": text(data.get("template_version"), "v1.0"),
        "template_source": text(data.get("template_source"), "附录14"),
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
