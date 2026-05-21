"""MCP 工具参数规范化（Agent 偶发传入 JSON 字符串等）。"""

from __future__ import annotations

import json
from typing import Any


def coerce_tool_context(context: Any) -> dict[str, Any]:
    """将 workshop 工具的 context 规范为 dict。"""
    if context is None:
        return {}
    if isinstance(context, dict):
        return dict(context)
    if isinstance(context, str):
        raw = context.strip()
        if not raw:
            return {}
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            return {"_raw_context": raw}
    return {}
