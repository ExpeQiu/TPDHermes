"""
将 OrchestrationPayload 适配为 Hermes-agent OpenAI 兼容请求。
"""

from __future__ import annotations

import json
import os
from typing import Any

from backend.schemas.orchestration import OrchestrationPayload

ORCHESTRATION_MARKER_BEGIN = "<<<ORCHESTRATION_JSON_BEGIN>>>"
ORCHESTRATION_MARKER_END = "<<<ORCHESTRATION_JSON_END>>>"


def orchestration_mode() -> str:
    return os.getenv("HERMES_ORCHESTRATION_MODE", "prompt").strip().lower()


def _build_orchestration_guidance(payload: OrchestrationPayload) -> str:
    knowledge_collections = [c for c in payload.knowledge.collections if c]
    preferred_skills = [s for s in payload.skills.preferred if s]
    allowed_skills = [s for s in payload.skills.allowed if s]
    candidate_skills = preferred_skills or allowed_skills

    lines = [
        "你是 TPDHermes 编排执行代理。你必须优先遵循 orchestration 中的边界、模板和技能策略。",
        "用户自然语言需求在对话消息中给出；不要在未授权时编造事实。",
        "项目附件与输出沉淀已写入 orchestration.knowledge.collections 中的 project.*.kb 集合；"
        "需要引用时请调用 kb_query / kb_get_entry 按需检索，不要假设 prompt 中已包含全文。",
    ]

    if knowledge_collections:
        lines.append(
            "当前知识检索范围仅限于这些 collections："
            + ", ".join(knowledge_collections)
            + "。"
        )

    if candidate_skills:
        lines.append(
            "当前可优先使用的 skills："
            + ", ".join(candidate_skills)
            + "。"
        )

    should_prefer_kb_skill = bool(knowledge_collections and candidate_skills)
    if should_prefer_kb_skill:
        lines.extend(
            [
                "当用户要求生成模板化内容、结构化文稿、发言稿、一页纸、短视频脚本，或明确要求结合知识库生成内容时，优先调用 `workshop_generate_from_kb`。",
                "调用要求：`collection_name` 必须从 orchestration.knowledge.collections 中选择，`skill_name` 必须从 orchestration.skills.preferred/allowed 中选择。",
                "为 `query` 提炼一个简洁检索词；仅在 `context` 中传入需要覆盖或补充的字段，例如 tone、cta、style、required_sections。",
                "如果 `workshop_generate_from_kb` 失败，再降级为 `kb_query` + `workshop_generate`，不要跳过工具直接编造最终内容。",
            ]
        )

    if payload.output.must_follow_template or payload.output.template_id:
        lines.append("当前输出必须尽量遵循模板或结构要求，优先产出结构完整的模板化结果。")
    if payload.output.required_sections:
        lines.append(
            "输出至少覆盖这些 section："
            + ", ".join(payload.output.required_sections)
            + "。"
        )

    return " ".join(lines)


def build_chat_completion_body(
    payload: OrchestrationPayload,
    messages: list[dict[str, Any]],
    model: str | None = None,
) -> dict[str, Any]:
    """
    构造转发给上游的 JSON body。
    - extra 模式：extra.orchestration 携带结构化编排（需上游支持）。
    - prompt 模式：在首条 system 中嵌入标记 JSON 块（默认）。
    """
    orch = payload.model_dump(mode="json")
    mode = orchestration_mode()
    model_name = model or os.getenv("HERMES_CHAT_MODEL", "hermes-agent")

    system_intro = _build_orchestration_guidance(payload)

    if mode == "extra":
        body: dict[str, Any] = {
            "model": model_name,
            "messages": [
                {"role": "system", "content": system_intro},
                *messages,
            ],
            "stream": payload.execution.stream,
            "extra": {"orchestration": orch},
        }
        return body

    embedded = (
        f"{system_intro}\n\n"
        f"{ORCHESTRATION_MARKER_BEGIN}\n"
        f"{json.dumps(orch, ensure_ascii=False)}\n"
        f"{ORCHESTRATION_MARKER_END}"
    )
    return {
        "model": model_name,
        "messages": [
            {"role": "system", "content": embedded},
            *messages,
        ],
        "stream": payload.execution.stream,
    }


def parse_sse_data_line(data: str) -> tuple[str, dict[str, Any] | None]:
    """
    解析单条 OpenAI SSE data JSON，返回 (delta_text, raw_dict)。
    """
    if not data or data == "[DONE]":
        return "", None
    try:
        parsed = json.loads(data)
    except json.JSONDecodeError:
        return "", None
    if not isinstance(parsed, dict):
        return "", None
    if parsed.get("error"):
        return "", parsed
    choices = parsed.get("choices")
    text = ""
    if isinstance(choices, list) and choices:
        c0 = choices[0]
        if isinstance(c0, dict):
            delta = c0.get("delta")
            if isinstance(delta, dict) and isinstance(delta.get("content"), str):
                text = delta["content"]
            elif isinstance(c0.get("message"), dict):
                mc = c0["message"].get("content")
                if isinstance(mc, str):
                    text = mc
    if not text and isinstance(parsed.get("content"), str):
        text = parsed["content"]
    return text, parsed
