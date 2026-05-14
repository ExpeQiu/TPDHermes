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

    system_intro = (
        "你是 TPDHermes 编排执行代理。你必须优先遵循 orchestration 中的边界、模板和技能策略。"
        "用户自然语言需求在对话消息中给出；不要在未授权时编造事实。"
    )

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
