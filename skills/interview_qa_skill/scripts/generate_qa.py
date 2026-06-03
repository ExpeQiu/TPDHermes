#!/usr/bin/env python3
"""Generate a leadership interview QA document from JSON input."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


DEFAULT_TITLE = "技术推广内容制作流程-领导采访QA"
EMPTY = "待补充"
SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
DEFAULT_TEMPLATE = SKILL_DIR / "templates" / "interview_qa.md"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a Chinese leadership interview QA document.")
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


def numbered_lines(value: Any) -> str:
    items = value if isinstance(value, list) else [EMPTY]
    return "\n".join(f"{index}. {text(item)}" for index, item in enumerate(items, start=1))


def bullet_lines(value: Any) -> str:
    if isinstance(value, list):
        return "\n".join(f"- {text(item)}" for item in value)
    return "- 开放：表达愿意沟通的态度\n- 自信：展现技术领先底气\n- 诚恳：直面问题，不回避"


def row_table(value: Any, keys: list[str]) -> str:
    if not isinstance(value, list) or not value:
        return "| " + " | ".join(EMPTY for _ in keys) + " |"

    rows: list[str] = []
    for item in value:
        data = item if isinstance(item, dict) else {}
        rows.append("| " + " | ".join(text(data.get(key)) for key in keys) + " |")
    return "\n".join(rows)


def default_templates() -> list[dict[str, str]]:
    return [
        {
            "type": "问题类型1：技术对比与竞品类",
            "typical_question": "相比XX，你们的优势在哪？",
            "challenge": "避免贬低对手，陷入参数口水战",
            "strategy": "拔高格局，定义差异",
            "talking_point": "我们尊重所有同行。但我们更关注为用户创造独特的价值。我们的不同在于[理念/路径差异]，例如我们更侧重于[具体场景体验]。",
        },
        {
            "type": "问题类型2：技术落地与承诺类",
            "typical_question": "L3自动驾驶何时能真正上路？",
            "challenge": "避免给出不切实际的时间表，防止未来被追责",
            "strategy": "分阶段阐述，强调安全与迭代",
            "talking_point": "技术的发展是渐进的，目前我们已经实现了[已落地功能]，并正在严格测试中。安全是我们一切功能释放的前提，会遵循法规，在成熟时第一时间推送。",
        },
        {
            "type": "问题类型3：成本与商业化类",
            "typical_question": "新技术会导致车型大幅涨价吗？",
            "challenge": "平衡技术先进性与市场接受度",
            "strategy": "强调价值与规模化效应",
            "talking_point": "成本是设计出来的，我们通过[自研、平台化]实现了成本优化。我们相信，为用户提供的[安全/体验]价值远超价格本身，且随着规模扩大，成本会进一步优化。",
        },
        {
            "type": "问题类型4：缺陷与风险类",
            "typical_question": "行业普遍有续航虚标问题，你们如何保证？",
            "challenge": "直面质疑，重建信任",
            "strategy": "承认关切，展示硬核措施",
            "talking_point": "我们理解用户的关切。为此，我们建立了更严格的测试标准，并邀请媒体和用户亲自验证。",
        },
        {
            "type": "问题类型5：战略与生态类",
            "typical_question": "你们的生态是封闭还是开放？",
            "challenge": "展现格局与协作能力",
            "strategy": "明确边界，突出共赢",
            "talking_point": "我们的战略是在核心领域深度自研，同时积极共建开放生态。",
        },
    ]


def template_blocks(value: Any) -> str:
    items = value if isinstance(value, list) and value else default_templates()
    blocks: list[str] = []
    for item in items:
        data = item if isinstance(item, dict) else {}
        blocks.append(
            f"---\n\n### {text(data.get('type'))}\n"
            f"**典型问题：** \"{text(data.get('typical_question'))}\"\n\n"
            f"**核心挑战：** {text(data.get('challenge'))}\n\n"
            f"**应答策略：** {text(data.get('strategy'))}\n\n"
            f"**参考话术：**\n> \"{text(data.get('talking_point'))}\""
        )
    return "\n\n".join(blocks)


def normalize(data: dict[str, Any]) -> dict[str, str]:
    personal = section(data, "personal_questions")
    return {
        "title": text(data.get("title"), DEFAULT_TITLE),
        "core_messages": numbered_lines(data.get("core_messages")),
        "answer_structure": text(
            data.get("answer_structure"),
            "[结论/核心观点] —— 这是最重要的，直接给出\n[论据1]          —— 支撑结论的具体数据/事实\n[论据2]          —— 补充说明\n[回归愿景]       —— 收尾，回归品牌核心主张",
        ),
        "attitude_principles": bullet_lines(data.get("attitude_principles")),
        "answer_template_blocks": template_blocks(data.get("answer_templates")),
        "must_answer_rows": row_table(data.get("must_answer_questions"), ["question", "answer_points", "forbidden_words"]),
        "sensitive_question_rows": row_table(data.get("sensitive_questions"), ["question", "risk_level", "strategy"]),
        "experience_background": text(personal.get("experience_background")),
        "personal_viewpoint": text(personal.get("personal_viewpoint")),
        "template_version": text(data.get("template_version"), "v1.0"),
        "template_source": text(data.get("template_source"), "附录17"),
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
