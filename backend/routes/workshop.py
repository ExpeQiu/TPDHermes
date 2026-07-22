"""
输出工坊 SSE API

SSE 端点 /ws/generate，接收 skill_name + context，
流式返回 Skill 生成结果。
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, AsyncGenerator, Dict

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import get_db
from backend.services.skill_loader import (
    SkillLoader,
    SkillNotFoundError,
    SkillLoadError,
    get_loader,
)
from backend.services.user_identity import get_effective_user_id
from backend.services.workshop_guard import (
    WorkshopGuardError,
    raise_http_if_workshop_guard_failed,
    require_workshop_invocation,
)
from backend.services.workshop_skill_access import visible_workshop_skill_names
from backend.services.workshop_task_runner import sse_error_event, sse_meta_event, sse_openai_delta

router = APIRouter(prefix="/ws", tags=["workshop"])
logger = logging.getLogger("tpdx.hermes.workshop")


def _loader_dep() -> SkillLoader:
    return get_loader()


# ─── Request / Response Models ─────────────────────────────────────────────────

class GenerateRequest(BaseModel):
    skill_name: str
    tphermes_run_id: str
    context: Dict[str, Any]


class GenerateFromKBRequest(BaseModel):
    skill_name: str
    tphermes_run_id: str
    query: str
    collection_name: str
    limit: int = 3
    project_id: str | None = None
    context: Dict[str, Any] | None = None


async def _generate_stream(
    skill_name: str,
    tphermes_run_id: str,
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
        yield sse_error_event(f"Skill '{skill_name}' not found", code="workshop_skill_not_found")
        return
    except SkillLoadError as e:
        yield sse_error_event(f"Failed to load skill: {e}", code="workshop_skill_load_error")
        return

    try:
        result = await asyncio.to_thread(skill.generate, context)
    except Exception as e:
        yield sse_error_event(f"Generation failed: {e}", code="workshop_generation_failed")
        return

    # ── 统一为 OpenAI 兼容 delta 事件 ───────────────────────────────────────
    if isinstance(result, str):
        for line in result.splitlines(keepends=True):
            yield sse_openai_delta(line)
    elif isinstance(result, dict):
        yield sse_openai_delta(json.dumps(result, ensure_ascii=False, indent=2))
    elif isinstance(result, list):
        for item in result:
            if isinstance(item, str):
                yield sse_openai_delta(item)
            else:
                yield sse_openai_delta(json.dumps(item, ensure_ascii=False))
    else:
        yield sse_openai_delta(str(result))

    yield sse_meta_event(
        {
            "tphermes_task": {
                "run_id": tphermes_run_id,
                "skill": skill_name,
                "status": "completed",
            }
        }
    )


# ─── SSE Endpoint ──────────────────────────────────────────────────────────────

@router.post("/generate", response_model=None)
async def generate_stream(
    request: GenerateRequest,
    loader: SkillLoader = Depends(_loader_dep),
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
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
    logger.info(
        "workshop generate stream user_id=%s skill=%s",
        effective_uid[:24],
        request.skill_name,
    )
    try:
        invocation = await require_workshop_invocation(
            db,
            tphermes_run_id=request.tphermes_run_id,
            skill_name=request.skill_name,
            viewer_user_id=effective_uid,
            project_id=request.context.get("project_id"),
        )
    except WorkshopGuardError as exc:
        raise_http_if_workshop_guard_failed(exc)
        raise HTTPException(status_code=500, detail="unexpected workshop guard state")

    context = dict(request.context)
    context["tphermes_run_id"] = invocation.run_id
    if invocation.project_id:
        context.setdefault("project_id", invocation.project_id)
    return StreamingResponse(
        _generate_stream(request.skill_name, invocation.run_id, context, loader),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",   # 禁用 Nginx 缓冲
        },
    )


# ─── Skill 发现端点（辅助） ────────────────────────────────────────────────────

@router.get("/skills", response_model=None)
async def list_skills(
    loader: SkillLoader = Depends(_loader_dep),
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    from backend.services.skill_package import resolve_skill_discovery

    visible = await visible_workshop_skill_names(
        db,
        effective_uid,
        enabled_only=True,
        require_loadable=True,
    )
    names = sorted(n for n in loader.discover() if n in visible)
    catalog = [resolve_skill_discovery(loader.skills_root / name, name) for name in names]
    return {"skills": names, "catalog": catalog, "count": len(names)}


@router.get("/skills/metadata", response_model=None)
async def list_skills_metadata(
    loader: SkillLoader = Depends(_loader_dep),
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    """技能元数据与输出模版选项，供场景编排页绑定 skill 后选择模版。"""
    visible = await visible_workshop_skill_names(
        db,
        effective_uid,
        enabled_only=True,
        require_loadable=True,
    )
    rows = [item for item in loader.list_skill_metadata() if str(item.get("name") or "") in visible]
    return {"skills": rows}


@router.post("/generate-from-kb", response_model=None)
async def generate_from_kb(
    request: GenerateFromKBRequest,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    """
    Query KB first, map results into a Skill context, then generate content.

    User-provided request.context overrides the auto-mapped fields.
    """
    logger.info(
        "workshop generate-from-kb user_id=%s skill=%s",
        effective_uid[:24],
        request.skill_name,
    )
    try:
        invocation = await require_workshop_invocation(
            db,
            tphermes_run_id=request.tphermes_run_id,
            skill_name=request.skill_name,
            viewer_user_id=effective_uid,
            project_id=request.project_id or (request.context or {}).get("project_id"),
            collection_name=request.collection_name,
        )
    except WorkshopGuardError as exc:
        raise_http_if_workshop_guard_failed(exc)
        raise HTTPException(status_code=500, detail="unexpected workshop guard state")

    from backend.tools.workshop_tools import workshop_generate_from_kb

    context = dict(request.context or {})
    context["tphermes_run_id"] = invocation.run_id
    if invocation.project_id:
        context["project_id"] = invocation.project_id
    return await workshop_generate_from_kb(
        skill_name=request.skill_name,
        query=request.query,
        collection_name=invocation.collection_name or request.collection_name,
        limit=request.limit,
        project_id=invocation.project_id,
        context=context,
    )
