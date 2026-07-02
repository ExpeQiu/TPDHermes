"""工坊编排执行与 SSE 事件帮助方法。"""

from __future__ import annotations

import json
import logging
from typing import Any, AsyncGenerator

from backend.services.skill_loader import SkillLoadError, SkillNotFoundError, get_loader
from backend.services.workshop_llm_generator import execute_workshop_skill_generate

logger = logging.getLogger("tpdx.hermes")


def _skill_result_to_text(result: Any) -> str:
    """将 skill.generate 返回值转为用户可见正文（优先 content 字段，避免整段 JSON）。"""
    if isinstance(result, str):
        stripped = result.strip()
        if stripped.startswith("{") and stripped.endswith("}"):
            try:
                parsed = json.loads(stripped)
                if isinstance(parsed, dict):
                    return _skill_result_to_text(parsed)
            except json.JSONDecodeError:
                pass
        return result
    if isinstance(result, dict):
        content = result.get("content")
        if isinstance(content, str) and content.strip():
            body = content.strip()
            title = result.get("title")
            if isinstance(title, str) and title.strip() and not body.lstrip().startswith("#"):
                return f"# {title.strip()}\n\n{body}"
            return body
    try:
        return json.dumps(result, ensure_ascii=False, indent=2)
    except TypeError:
        return str(result)


def _parse_workshop_context(user_message: str) -> dict[str, Any]:
    try:
        data = json.loads(user_message)
        if isinstance(data, dict):
            return dict(data)
    except (json.JSONDecodeError, TypeError):
        pass
    return {"_raw_user_message": user_message}


def sse_openai_delta(content: str) -> str:
    payload = {"choices": [{"index": 0, "delta": {"content": content}}]}
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def sse_error_event(message: str, *, code: str = "workshop_error") -> str:
    payload = {"error": {"message": message, "code": code}}
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def sse_meta_event(meta: dict[str, Any]) -> str:
    return f"data: {json.dumps(meta, ensure_ascii=False)}\n\n"


async def run_workshop_skill_async(skill_name: str, context: dict[str, Any]) -> str:
    loader = get_loader()
    try:
        skill = loader.load(skill_name)
    except SkillNotFoundError as e:
        raise RuntimeError(f"Skill not found: {skill_name}") from e
    except SkillLoadError as e:
        raise RuntimeError(f"Skill load error: {e}") from e

    result = await execute_workshop_skill_generate(skill, context)

    text = _skill_result_to_text(result)
    logger.info("workshop_direct skill=%s result_len=%s", skill_name, len(text))
    return text


async def stream_workshop_as_openai_sse(
    skill_name: str,
    context: dict[str, Any],
    *,
    line_chunk: bool = True,
) -> AsyncGenerator[str, None]:
    """将 skill 输出切成 OpenAI 兼容 SSE delta 行。"""
    text = await run_workshop_skill_async(skill_name, context)
    if line_chunk:
        for line in text.splitlines(keepends=True):
            yield sse_openai_delta(line)
    else:
        chunk_size = 256
        for i in range(0, len(text), chunk_size):
            yield sse_openai_delta(text[i : i + chunk_size])
