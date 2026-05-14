"""
输出工坊 SSE API

SSE 端点 /ws/generate，接收 skill_name + context，
流式返回 Skill 生成结果。
"""

from __future__ import annotations

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from typing import Any, AsyncGenerator, Dict

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from backend.services.skill_loader import (
    SkillLoader,
    SkillNotFoundError,
    SkillLoadError,
    get_loader,
)

router = APIRouter(prefix="/ws", tags=["workshop"])


def _loader_dep() -> SkillLoader:
    return get_loader()


# ─── Request / Response Models ─────────────────────────────────────────────────

class GenerateRequest(BaseModel):
    skill_name: str
    context: Dict[str, Any]


# ─── SSE Event Helpers ────────────────────────────────────────────────────────

def sse_event(data: Dict[str, Any]) -> str:
    """将 dict 序列化为 SSE data 行"""
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


async def _generate_stream(
    skill_name: str,
    context: Dict[str, Any],
    loader: SkillLoader,
) -> AsyncGenerator[str, None]:
    """
    核心流生成逻辑：
    1. 加载 Skill
    2. 先发送 start 事件
    3. 在线程池中执行同步 Skill.generate()（支持协程生成器）
    4. 分片发送 chunk 事件
    5. 发送 done / error 事件
    """
    # ── 加载 Skill ────────────────────────────────────────────────────────────
    try:
        skill = loader.load(skill_name)
    except SkillNotFoundError:
        yield sse_event({"type": "error", "message": f"Skill '{skill_name}' not found"})
        return
    except SkillLoadError as e:
        yield sse_event({"type": "error", "message": f"Failed to load skill: {e}"})
        return

    # ── 发送开始事件 ──────────────────────────────────────────────────────────
    yield sse_event({
        "type": "start",
        "skill": skill_name,
        "context_keys": list(context.keys()),
    })

    # ── 在线程池执行 Skill.generate（支持协程生成器） ─────────────────────────
    loop = asyncio.get_running_loop()
    executor = ThreadPoolExecutor(max_workers=1)

    try:
        result = await loop.run_in_executor(executor, lambda: skill.generate(context))
    except Exception as e:
        yield sse_event({"type": "error", "message": f"Generation failed: {e}"})
        return
    finally:
        executor.shutdown(wait=False)

    # ── 分片发送结果（支持 str / dict / list） ────────────────────────────────
    if isinstance(result, str):
        # 按行分片
        for line in result.splitlines(keepends=True):
            yield sse_event({"type": "chunk", "content": line})
    elif isinstance(result, dict):
        # 整体作为 chunk 发送
        yield sse_event({"type": "chunk", "content": result})
    elif isinstance(result, list):
        for item in result:
            yield sse_event({"type": "chunk", "content": item})
    else:
        yield sse_event({"type": "chunk", "content": str(result)})

    # ── 发送完成事件 ─────────────────────────────────────────────────────────
    yield sse_event({"type": "done", "skill": skill_name})


# ─── SSE Endpoint ──────────────────────────────────────────────────────────────

@router.post("/generate", response_model=None)
async def generate_stream(
    request: GenerateRequest,
    loader: SkillLoader = Depends(_loader_dep),
):
    """
    SSE 流式生成端点。

    请求体:
        skill_name: str   - Skill 名称（对应 skills/{skill_name}/ 目录）
        context: dict     - 传递给 Skill.generate() 的上下文

    SSE 事件流:
        1. event: start   - 包含 skill 名称和 context keys
        2. event: chunk   - 每个生成片段（str / dict / list）
        3. event: done    - 生成完成
        4. event: error   - 错误（任何阶段均可能触发）

    示例:
        curl -X POST http://localhost:8000/ws/generate \\
          -H "Content-Type: application/json" \\
          -d '{"skill_name": "hello_skill", "context": {"name": "Alice"}}'
    """
    return StreamingResponse(
        _generate_stream(request.skill_name, request.context, loader),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",   # 禁用 Nginx 缓冲
        },
    )


# ─── Skill 发现端点（辅助） ────────────────────────────────────────────────────

@router.get("/skills", response_model=None)
async def list_skills(loader: SkillLoader = Depends(_loader_dep)):
    return {"skills": loader.discover()}
