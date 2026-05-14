"""
工坊编排：确定性执行选中的 Skill.generate，不依赖 Agent 自行理解白名单。
"""

from __future__ import annotations

import asyncio
import json
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Any, AsyncGenerator

from backend.schemas.orchestration import OrchestrationPayload
from backend.services.skill_loader import SkillLoadError, SkillNotFoundError, get_loader

logger = logging.getLogger("tpdx.hermes")


def _skill_result_to_text(result: Any) -> str:
    if isinstance(result, str):
        return result
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


async def run_workshop_skill_async(skill_name: str, context: dict[str, Any]) -> str:
    loader = get_loader()
    try:
        skill = loader.load(skill_name)
    except SkillNotFoundError as e:
        raise RuntimeError(f"Skill not found: {skill_name}") from e
    except SkillLoadError as e:
        raise RuntimeError(f"Skill load error: {e}") from e

    loop = asyncio.get_running_loop()
    executor = ThreadPoolExecutor(max_workers=1)
    try:
        result = await loop.run_in_executor(executor, lambda: skill.generate(context))
    finally:
        executor.shutdown(wait=False)

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
