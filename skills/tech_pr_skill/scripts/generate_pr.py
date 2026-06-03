#!/usr/bin/env python3
"""Generate an official technology PR/news release from JSON input."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


DEFAULT_TITLE = "[主标题：突出技术核心与用户价值]"
EMPTY = "待补充"
SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
DEFAULT_TEMPLATE = SKILL_DIR / "templates" / "tech_pr.md"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a Chinese technology PR release.")
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


def feature_blocks(value: Any) -> str:
    items = value if isinstance(value, list) else []
    if not items:
        items = [{}, {}, {}]

    blocks: list[str] = []
    for index, item in enumerate(items[:3], start=1):
        data = item if isinstance(item, dict) else {}
        prefix = ["在", "在", "在"][min(index - 1, 2)]
        suffix = ["层面", "维度", "方面"][min(index - 1, 2)]
        blocks.append(
            f"**{prefix}{text(data.get('level'), f'技术层面{index}')}{suffix}**，"
            f"该平台采用了创新的 **{text(data.get('tech_name'))}**，"
            f"不仅实现了 **{text(data.get('effect'))}**，"
            f"更可在 **{text(data.get('scenario'))}** 的情况下 **{text(data.get('user_benefit'))}**，"
            f"有效解决了 **{text(data.get('pain_point'))}** 的问题。"
        )
    return "\n\n".join(blocks)


def normalize(data: dict[str, Any]) -> dict[str, str]:
    lead = section(data, "lead")
    problem = section(data, "problem_and_idea")
    leader = section(data, "leader_quote")
    strategy = section(data, "strategy_plan")
    contact = section(data, "media_contact")

    leader_quote = leader.get("quote")
    if not leader_quote:
        leader_quote = (
            f"{text(data.get('tech_brand_name'))} 的发布，是我们对 **{text(leader.get('future_trend'))}** 的坚定回答。"
            f"它不仅仅是一个技术平台，更是我们承诺为用户创造 **{text(leader.get('core_value'))}** 的基石。"
            "我们相信，真正的技术领先，是让复杂的创新化为用户触手可及的安心与愉悦。"
        )

    return {
        "main_title": text(data.get("main_title"), DEFAULT_TITLE),
        "subtitle": text(data.get("subtitle"), "[副标题：补充技术定位或发布意义（可选）]"),
        "city": text(data.get("city"), "发布城市"),
        "date": text(data.get("date"), "年/月/日"),
        "company_name": text(data.get("company_name"), "[公司名称]"),
        "tech_brand_name": text(data.get("tech_brand_name"), "[技术品牌/平台名称]"),
        "domain": text(data.get("domain"), "[所属领域]"),
        "core_user_value": text(data.get("core_user_value"), "[核心用户价值]"),
        "product_type": text(data.get("product_type"), "[产品类型]"),
        "core_idea": text(lead.get("core_idea"), "[核心理念]"),
        "innovation_1": text(lead.get("innovation_1"), "[关键创新技术1]"),
        "innovation_2": text(lead.get("innovation_2"), "[关键创新技术2]"),
        "innovation_3": text(lead.get("innovation_3"), "[关键创新技术3]"),
        "performance_breakthrough": text(lead.get("performance_breakthrough"), "[关键性能突破]"),
        "subsystem": text(lead.get("subsystem"), "[具体子系统名称]"),
        "metric_improvement": text(lead.get("metric_improvement"), "[某项性能指标]提升了[XX%]"),
        "metric_reduction": text(lead.get("metric_reduction"), "[另一项指标]降低了[XX%]"),
        "industry_challenge": text(problem.get("industry_challenge"), "[行业或用户面临的普遍挑战]"),
        "architecture_layers": text(problem.get("architecture_layers"), "[底层架构]"),
        "technical_principle": text(problem.get("technical_principle"), "[技术理念/原则]"),
        "tech_feature_blocks": feature_blocks(data.get("tech_features")),
        "leader_position": text(leader.get("position"), "[高级领导职位]"),
        "leader_name": text(leader.get("name"), "[领导姓名]"),
        "leader_quote": text(leader_quote),
        "company_strategy": text(strategy.get("company_strategy"), "[公司整体战略]"),
        "future_years": text(strategy.get("future_years"), "[数字]"),
        "planned_models": text(strategy.get("planned_models"), "[预计推出的车型数量或系列]"),
        "future_vision": text(strategy.get("future_vision"), "[公司或行业愿景]"),
        "ecosystem_vision": text(strategy.get("ecosystem_vision"), "[生态愿景]"),
        "company_profile": text(data.get("company_profile"), "[公司简介，建议50字以内，涵盖核心技术方向和市场定位]"),
        "contact_name": text(contact.get("name"), "[联系人]"),
        "contact_email": text(contact.get("email"), "[邮箱]"),
        "contact_phone": text(contact.get("phone"), "[电话]"),
        "template_version": text(data.get("template_version"), "v1.0"),
        "template_source": text(data.get("template_source"), "附录18"),
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
