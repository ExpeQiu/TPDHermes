"""工坊执行模式与 tool capture 解析。"""
from __future__ import annotations

import json
import os
from typing import Any


def workshop_execution_mode() -> str:
    raw = os.getenv("WORKSHOP_EXECUTION_MODE", "agent").strip().lower()
    return "direct" if raw == "direct" else "agent"


def workshop_agent_fallback_direct() -> bool:
    return os.getenv("WORKSHOP_AGENT_FALLBACK_DIRECT", "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def _stringify_content(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, indent=2)
    except TypeError:
        return str(value)


def extract_text_from_tool_payload(tool_name: str, payload: dict[str, Any]) -> str:
    """从 workshop_generate / workshop_generate_from_kb 返回值提取落库正文。"""
    if not payload:
        return ""

    if tool_name == "workshop_generate_from_kb":
        gen = payload.get("generation")
        if isinstance(gen, dict):
            if gen.get("success") is False:
                return ""
            inner = gen.get("content")
            if inner is not None:
                return _stringify_content(inner)
        if payload.get("success") is False:
            return ""

    if payload.get("success") is False:
        return ""

    content = payload.get("content")
    if content is not None:
        return _stringify_content(content)

    gen = payload.get("generation")
    if isinstance(gen, dict) and gen.get("content") is not None:
        return _stringify_content(gen.get("content"))

    return _stringify_content(payload)


def parse_tool_capture_json(raw: str | None) -> dict[str, Any] | None:
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def primary_text_from_capture(capture: dict[str, Any] | None) -> str:
    if not capture:
        return ""
    primary = capture.get("primary_content")
    if isinstance(primary, str) and primary.strip():
        return primary
    artifacts = capture.get("artifacts")
    if isinstance(artifacts, list):
        for item in reversed(artifacts):
            if not isinstance(item, dict):
                continue
            text = item.get("content_text")
            if isinstance(text, str) and text.strip():
                return text
    return ""
