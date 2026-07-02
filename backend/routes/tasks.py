"""
统一编排任务入口：POST /tasks/execute，GET /runs/{run_id}
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from typing import Any, AsyncGenerator

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import get_db, async_session_maker
from backend.models.orchestration_run import OrchestrationRun
from backend.models.output_asset import OutputAsset
from backend.routes.chat import _chat_target_required
from backend.schemas.orchestration import OrchestrationPayload, TaskExecuteRequest, TaskInputPayload
from backend.services.agent_gateway import (
    build_chat_completion_body,
    is_lightweight_chat_message,
    parse_sse_data_line,
    should_skip_kb_prefetch_for_co_create_draft,
)
from backend.services.orchestration_service import (
    ProjectNotFoundError,
    ScenarioVersionMismatchError,
    WorkshopBindingError,
    assemble_payload,
    merge_chat_messages,
)
from backend.services.project_kb import merge_project_kb_collections, output_doc_id, project_kb_collection
from backend.services.project_kb_ingest import schedule_ingest_output
from backend.services.project_access import require_project_for_user
from backend.services.run_log_service import create_run, finalize_run, mark_run_failed
from backend.services.template_service import extract_required_sections, get_template_by_id, validate_markdown_sections
from backend.services.workshop_guard import (
    WorkshopGuardError,
    ensure_single_workshop_skill_contract,
    require_workshop_collection_for_user,
    require_workshop_skill_for_user,
)
from backend.services.workshop_task_runner import (
    _parse_workshop_context,
    run_workshop_skill_async,
    sse_error_event,
    sse_meta_event,
    sse_openai_delta,
)
from backend.services.workshop_execution import (
    primary_text_from_capture,
    workshop_agent_fallback_direct,
    workshop_execution_mode,
)
from backend.services.workshop_tool_capture import load_workshop_tool_capture
from backend.services.kb_source_capture import build_sources_for_sse, build_sources_payload_from_capture, load_kb_sources, prefetch_kb_sources_for_run
from backend.services.user_identity import effective_user_id_for_api, viewer_role

logger = logging.getLogger("tpdx.hermes")

_EMPTY_ASSISTANT_CONTENT_ERROR = (
    "Agent 未返回可见正文（可能为 Hermes 冷启动或 SSE 提前断开）。"
    "请重试；若持续失败请检查 hermes-agent 日志。"
)

router = APIRouter(prefix="/tasks", tags=["tasks"])


def _resolve_run_status_and_error(
    assistant_content: str,
    *,
    must_follow_template: bool,
    validation_ok: bool,
) -> tuple[str, str | None]:
    if not (assistant_content or "").strip():
        return "failed", _EMPTY_ASSISTANT_CONTENT_ERROR
    if must_follow_template and not validation_ok:
        return "draft", None
    return "completed", None
runs_router = APIRouter(prefix="/runs", tags=["runs"])


def _env_int(name: str, default: int, *, min_value: int = 1, max_value: int = 100_000) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        v = int(raw)
    except ValueError:
        return default
    return max(min_value, min(max_value, v))


def _env_float(
    name: str,
    default: float,
    *,
    min_value: float = 0.0,
    max_value: float = 100_000.0,
) -> float:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        v = float(raw)
    except ValueError:
        return default
    return max(min_value, min(max_value, v))


def _trim_chat_messages(messages: list[dict[str, str]]) -> list[dict[str, str]]:
    """
    P0：限制历史窗口，避免每轮输入无限膨胀。
    仅保留最近 N 条，并截断超长 content。
    """
    max_messages = _env_int("CHAT_HISTORY_MAX_MESSAGES", 12, min_value=2, max_value=200)
    max_chars = _env_int("CHAT_HISTORY_MAX_CHARS_PER_MESSAGE", 2000, min_value=200, max_value=20_000)
    if len(messages) > max_messages:
        messages = messages[-max_messages:]
    out: list[dict[str, str]] = []
    for m in messages:
        content = (m.get("content") or "").strip()
        if len(content) > max_chars:
            content = content[:max_chars] + "\n...(历史过长已截断)"
        out.append({"role": m.get("role", "user"), "content": content})
    return out


def _apply_chat_generation_limits(body: dict[str, Any]) -> None:
    """
    P0：默认注入输出上限，降低长响应导致的 20s+ 等待。
    """
    cap = _env_int("CHAT_MAX_TOKENS", 700, min_value=64, max_value=8_192)
    body.setdefault("max_tokens", cap)
    # 兼容不同上游字段命名（OpenAI/Anthropic 风格）。
    body.setdefault("max_completion_tokens", cap)
    body.setdefault("max_output_tokens", cap)


def _chat_client(timeout: httpx.Timeout) -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=timeout, trust_env=False)


def _format_upstream_error(status_code: int, detail: bytes) -> dict[str, Any]:
    if detail:
        try:
            parsed = json.loads(detail.decode("utf-8", errors="ignore"))
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            return parsed
    return {
        "error": {
            "message": f"Hermes-agent upstream error (HTTP {status_code})",
            "code": f"http_{status_code}",
        }
    }


def _extract_sse_blocks(buffer: str) -> tuple[list[str], str]:
    normalized = buffer.replace("\r\n", "\n")
    parts = normalized.split("\n\n")
    return [part for part in parts[:-1] if part.strip()], parts[-1] if parts else ""


def _parse_sse_block(block: str) -> tuple[str, str] | None:
    event = "message"
    data_lines: list[str] = []
    for raw_line in block.split("\n"):
        line = raw_line.rstrip()
        if not line:
            continue
        if line.startswith("event:"):
            event = line[6:].strip() or "message"
            continue
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
    if not data_lines:
        return None
    return event, "\n".join(data_lines).strip()


KNOWN_TOOL_NAMES = frozenset({
    "write_file",
    "patch",
    "kb_query",
    "kb_get_entry",
    "kb_list_collections",
    "tavily_search",
    "tavily_extract",
    "workshop_generate",
    "workshop_generate_from_kb",
})


def _parse_tool_progress_event(data: str) -> dict[str, Any] | None:
    if not data:
        return None
    try:
        parsed = json.loads(data)
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    tool_name = parsed.get("tool") or parsed.get("tool_name") or parsed.get("toolName")
    if not isinstance(tool_name, str) or tool_name not in KNOWN_TOOL_NAMES:
        return None
    tool_call_id = parsed.get("toolCallId") or parsed.get("tool_call_id")
    status = parsed.get("status")
    if not isinstance(tool_call_id, str) or not tool_call_id:
        return None
    if status not in ("running", "completed", "failed"):
        return None
    path = parsed.get("path")
    label = parsed.get("label")
    normalized: dict[str, Any] = {
        "tool_call_id": tool_call_id,
        "tool_name": tool_name,
        "status": status,
    }
    if isinstance(label, str) and label.strip():
        normalized["label"] = label.strip()
    if isinstance(parsed.get("emoji"), str) and parsed.get("emoji"):
        normalized["emoji"] = parsed["emoji"]
    if isinstance(parsed.get("summary"), str) and parsed.get("summary"):
        normalized["summary"] = parsed["summary"]
    if isinstance(path, str) and path.strip():
        normalized["path"] = path.strip()
    elif isinstance(label, str) and label.strip():
        normalized["path"] = label.strip()
    return normalized


def _parse_file_tool_event(data: str) -> dict[str, Any] | None:
    """兼容旧调用名。"""
    return _parse_tool_progress_event(data)


def _merge_tool_event_rows(
    current: list[dict[str, Any]],
    incoming: dict[str, Any],
) -> list[dict[str, Any]]:
    tool_call_id = incoming.get("tool_call_id")
    if not isinstance(tool_call_id, str) or not tool_call_id:
        return current
    for index, item in enumerate(current):
        if item.get("tool_call_id") == tool_call_id:
            next_rows = current[:]
            next_rows[index] = {**item, **incoming}
            return next_rows
    return [*current, incoming]


async def _validate_task_request(
    db: AsyncSession,
    request: TaskExecuteRequest,
    payload: OrchestrationPayload,
    *,
    effective_uid: str,
) -> None:
    if request.entrypoint == "workshop":
        try:
            skill_name = ensure_single_workshop_skill_contract(payload.skills.allowed)
        except WorkshopGuardError as exc:
            raise HTTPException(
                status_code=exc.status_code,
                detail=exc.detail,
            ) from exc
        try:
            await require_workshop_skill_for_user(
                db,
                viewer_user_id=effective_uid,
                skill_name=skill_name,
            )
            for collection_name in payload.knowledge.collections:
                await require_workshop_collection_for_user(
                    db,
                    viewer_user_id=effective_uid,
                    collection_name=collection_name,
                    project_id=request.project_id,
                )
        except WorkshopGuardError as exc:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc

    if payload.output.must_follow_template and payload.output.template_id:
        tpl = await get_template_by_id(db, payload.output.template_id)
        if not tpl:
            raise HTTPException(status_code=400, detail="模板不存在或不可用")


def _merge_required_sections(payload: OrchestrationPayload, template_sections: list[str]) -> OrchestrationPayload:
    merged = list(dict.fromkeys([*payload.output.required_sections, *template_sections]))
    return payload.model_copy(
        update={"output": payload.output.model_copy(update={"required_sections": merged})}
    )


def _response_meta(
    payload: OrchestrationPayload,
    *,
    used_skills: list[str] | None = None,
    execution_mode: str | None = None,
    tool_capture_hit: bool = False,
    citations_meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    meta: dict[str, Any] = {
        "used_skills": used_skills or [],
        "used_collections": [],
        "skills_policy": payload.skills.model_dump(),
        "skills_violations": [],
    }
    if execution_mode:
        meta["execution_mode"] = execution_mode
    if payload.entrypoint == "workshop" or used_skills:
        meta["tool_capture_hit"] = tool_capture_hit
    if citations_meta:
        meta["citations_count"] = citations_meta.get("citations_count", 0)
        meta["unresolved_refs"] = citations_meta.get("unresolved_refs") or []
    return meta


def _must_have_headings(payload: OrchestrationPayload) -> bool:
    vr = payload.output.validation_rules
    return True if vr is None else bool(vr.must_have_headings)


def _workshop_skill_context(user_text: str, task_input: TaskInputPayload | None) -> dict[str, Any]:
    context = _parse_workshop_context(user_text)
    if task_input is not None:
        context["task_input"] = task_input.model_dump(exclude_none=True)
    return context


async def _run_workshop_direct_text(
    skill_name: str,
    user_text: str,
    task_input: TaskInputPayload | None,
) -> str:
    context = _workshop_skill_context(user_text, task_input)
    return await run_workshop_skill_async(skill_name, context)


async def _resolve_workshop_agent_output(
    *,
    run_id: str,
    sse_fallback: str,
    skill_name: str,
    user_text: str,
    task_input: TaskInputPayload | None,
) -> tuple[str, bool, str]:
    """
    返回 (落库正文, tool_capture_hit, execution_mode)。
    execution_mode 可能因 fallback 变为 direct。
    """
    async with async_session_maker() as db:
        capture = await load_workshop_tool_capture(db, run_id)
    text = primary_text_from_capture(capture)
    if text.strip():
        return text, True, "agent"

    if workshop_agent_fallback_direct():
        logger.warning(
            "workshop agent capture miss run_id=%s fallback=direct skill=%s sse_len=%s",
            run_id,
            skill_name,
            len(sse_fallback),
        )
        try:
            direct_text = await _run_workshop_direct_text(skill_name, user_text, task_input)
        except RuntimeError as exc:
            raise HTTPException(
                status_code=424,
                detail=f"Agent 未调用 workshop 工具且直连降级失败: {exc}",
            ) from exc
        return direct_text, False, "direct"

    detail = (
        "Agent 未调用 workshop_generate / workshop_generate_from_kb，无法获取产出正文。"
        "请确认 Hermes-agent 已连接 tphermes MCP 且编排指令生效。"
    )
    if sse_fallback.strip():
        logger.warning(
            "workshop agent capture miss run_id=%s sse_len=%s",
            run_id,
            len(sse_fallback),
        )
    raise HTTPException(status_code=424, detail=detail)


def _chat_force_skill_mode(
    payload: OrchestrationPayload,
    *,
    chat_mode: str | None = None,
) -> bool:
    """
    chat 入口仅在“显式单技能白名单”时强制要求命中 tool 调用。
    共创 co_create（含快捷创作）须基于项目+场景走 Hermes 编排，禁止直连技能模板。
    """
    if chat_mode == "co_create":
        return False
    if payload.entrypoint != "chat":
        return False
    if payload.skills.allow_agent_free_choice:
        return False
    if payload.skills.mode not in ("allowed_list", "manual_only"):
        return False
    allowed = [s for s in payload.skills.allowed if s]
    return len(allowed) == 1


async def _resolve_chat_skill_output(
    *,
    run_id: str,
    payload: OrchestrationPayload,
    sse_fallback: str,
    user_text: str,
    task_input: TaskInputPayload | None,
    chat_mode: str | None = None,
) -> tuple[str, bool, str, list[str] | None]:
    """
    chat 入口：
    1) 若 agent 已调用 workshop tool，优先采用 tool capture 正文；
    2) 若显式单技能白名单但未命中 tool，则直连技能兜底，确保“可调用”语义成立；
    3) 其他情况保持 agent 原文。
    """
    allowed = [s for s in payload.skills.allowed if s]
    async with async_session_maker() as db:
        capture = await load_workshop_tool_capture(db, run_id)
    captured_text = primary_text_from_capture(capture)
    if captured_text.strip():
        used = allowed[:1] if allowed else None
        return captured_text, True, "agent_tool", used

    if _chat_force_skill_mode(payload, chat_mode=chat_mode):
        skill_name = allowed[0]
        logger.warning(
            "chat forced skill capture miss run_id=%s fallback=direct skill=%s",
            run_id,
            skill_name,
        )
        try:
            direct_text = await _run_workshop_direct_text(skill_name, user_text, task_input)
        except RuntimeError as exc:
            raise HTTPException(
                status_code=424,
                detail=f"Chat 未命中技能工具且直连降级失败: {exc}",
            ) from exc
        return direct_text, False, "direct_skill_fallback", [skill_name]

    return sse_fallback, False, "agent_text", None


@router.post("/execute")
async def execute_task(req: Request, task_req: TaskExecuteRequest, db: AsyncSession = Depends(get_db)):
    effective_uid = effective_user_id_for_api(req, body_user_id=task_req.user_id)
    actor_role = (task_req.user_role or "").strip() or viewer_role(req)
    logger.info(
        "[chat-output-context] tasks execute user_id=%s entrypoint=%s project_id=%s chat_mode=%s source_output_id=%s",
        effective_uid[:24],
        task_req.entrypoint,
        task_req.project_id,
        task_req.chat_mode,
        task_req.source_output_id,
    )
    eff_request = task_req
    if eff_request.entrypoint == "chat" and eff_request.chat_mode == "doc_optimize":
        if not (eff_request.source_output_id or "").strip():
            raise HTTPException(status_code=400, detail="文稿优化场景必须指定来源输出文档")
        if not (eff_request.project_id or "").strip():
            raise HTTPException(status_code=400, detail="文稿优化场景必须指定项目")
    refine_full_source = os.getenv("WORKSHOP_REFINE_FULL_SOURCE", "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )
    if (
        eff_request.entrypoint in ("workshop", "chat")
        and eff_request.source_output_id
        and (eff_request.project_id or "").strip()
    ):
        oid = eff_request.source_output_id.strip()
        pid = eff_request.project_id.strip()
        q = await db.execute(
            select(OutputAsset).where(
                OutputAsset.id == oid,
                OutputAsset.project_id == pid,
            )
        )
        src_row = q.scalar_one_or_none()
        if not src_row:
            raise HTTPException(status_code=404, detail=f"来源输出不存在: {oid}")
        use_full_source = (
            refine_full_source
            or eff_request.entrypoint == "chat"
            or eff_request.chat_mode == "doc_optimize"
        )
        if use_full_source:
            material = (src_row.content or "").strip()
            ti = eff_request.task_input
            if not material:
                raise HTTPException(status_code=400, detail="来源输出正文为空，无法优化")
            logger.info(
                "[chat-output-context] 注入完整正文 source_output_id=%s chars=%s chat_mode=%s",
                oid,
                len(material),
                eff_request.chat_mode,
            )
            if ti is None:
                eff_request = eff_request.model_copy(
                    update={"task_input": TaskInputPayload(source_material=material)}
                )
            elif not (ti.source_material and str(ti.source_material).strip()):
                eff_request = eff_request.model_copy(
                    update={"task_input": ti.model_copy(update={"source_material": material})},
                )
        else:
            schedule_ingest_output(oid)
            kb_col = project_kb_collection(pid)
            doc_id = output_doc_id(oid)
            hint = (
                f"来源输出已入项目知识库 collection={kb_col}，doc_id={doc_id}；"
                f"请用 kb_query 或 kb_get_entry 按需检索片段，勿臆造未检索内容。"
            )
            ti = eff_request.task_input
            if ti is None:
                eff_request = eff_request.model_copy(update={"task_input": TaskInputPayload(extra=hint)})
            elif not (ti.extra and str(ti.extra).strip()):
                eff_request = eff_request.model_copy(
                    update={"task_input": ti.model_copy(update={"extra": hint})},
                )
            else:
                merged_extra = f"{ti.extra.strip()}\n{hint}"
                eff_request = eff_request.model_copy(
                    update={"task_input": ti.model_copy(update={"extra": merged_extra})},
                )

    pid_for_refs = (eff_request.project_id or "").strip()
    if pid_for_refs and pid_for_refs != "none" and (
        eff_request.project_file_ids or eff_request.pinned_file_ids
    ):
        from backend.services.project_files_service import build_referenced_files_extra

        ref_extra = await build_referenced_files_extra(
            db,
            pid_for_refs,
            list(eff_request.project_file_ids or []),
            list(eff_request.pinned_file_ids or []),
        )
        if ref_extra.strip():
            ti = eff_request.task_input
            if ti is None:
                eff_request = eff_request.model_copy(
                    update={"task_input": TaskInputPayload(extra=ref_extra)},
                )
            elif ti.extra and str(ti.extra).strip():
                eff_request = eff_request.model_copy(
                    update={
                        "task_input": ti.model_copy(
                            update={"extra": f"{ti.extra.strip()}\n\n{ref_extra}"},
                        ),
                    },
                )
            else:
                eff_request = eff_request.model_copy(
                    update={"task_input": ti.model_copy(update={"extra": ref_extra})},
                )
            logger.info(
                "[co-create] 注入结构化文件引用 project_id=%s round=%s pinned=%s",
                pid_for_refs,
                len(eff_request.project_file_ids or []),
                len(eff_request.pinned_file_ids or []),
            )

    pid_strip = (eff_request.project_id or "").strip()
    if pid_strip and pid_strip != "none":
        await require_project_for_user(db, pid_strip, effective_uid, detail="项目不存在")

    try:
        payload, snapshot = await assemble_payload(
            db,
            eff_request,
            effective_user_id=effective_uid,
            actor_role=actor_role,
        )
    except ProjectNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"项目不存在: {exc.project_id}") from exc
    except WorkshopBindingError as exc:
        raise HTTPException(status_code=400, detail=exc.detail) from exc
    except ScenarioVersionMismatchError as exc:
        raise HTTPException(status_code=409, detail=exc.detail) from exc

    if eff_request.source_output_id:
        snapshot = {**snapshot, "source_output_id": eff_request.source_output_id.strip()}
    if eff_request.chat_mode:
        snapshot = {**snapshot, "chat_mode": eff_request.chat_mode}
    if eff_request.co_create_agent_mode:
        snapshot = {**snapshot, "co_create_agent_mode": eff_request.co_create_agent_mode}
    if eff_request.session_id:
        snapshot = {**snapshot, "session_id": eff_request.session_id.strip()}

    user_text = payload.user_input.message

    tpl_sections: list[str] = []
    if payload.output.template_id:
        tpl = await get_template_by_id(db, payload.output.template_id)
        if tpl:
            tpl_sections = extract_required_sections(tpl)
            payload = _merge_required_sections(payload, tpl_sections)

    await _validate_task_request(db, eff_request, payload, effective_uid=effective_uid)

    run_id = str(uuid.uuid4())
    await create_run(
        db,
        run_id=run_id,
        project_id=eff_request.project_id,
        scenario_id=eff_request.scenario_id,
        entrypoint=eff_request.entrypoint,
        user_id=effective_uid,
        request_json=eff_request.model_dump_json(),
        snapshot_json=json.dumps(snapshot, ensure_ascii=False),
        skills_policy_json=json.dumps(payload.skills.model_dump(), ensure_ascii=False),
    )

    payload = payload.model_copy(
        update={"execution": payload.execution.model_copy(update={"run_id": run_id})}
    )
    snapshot = {**snapshot, "run_id": run_id}

    is_workshop = eff_request.entrypoint == "workshop"
    ws_mode = workshop_execution_mode() if is_workshop else None
    workshop_skill: str | None = None
    if is_workshop:
        workshop_skill = payload.skills.allowed[0]
        logger.info(
            "workshop execute run_id=%s mode=%s skill=%s project_id=%s",
            run_id,
            ws_mode,
            workshop_skill,
            eff_request.project_id,
        )
        snapshot = {**snapshot, "workshop_execution_mode": ws_mode}

    if is_workshop and ws_mode == "direct":
        user_text_ws = payload.user_input.message

        if not eff_request.stream:
            t0 = time.perf_counter()
            try:
                text = await _run_workshop_direct_text(
                    workshop_skill,
                    user_text_ws,
                    eff_request.task_input,
                )
            except RuntimeError as exc:
                await mark_run_failed(db, run_id, str(exc))
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            duration_ms = int((time.perf_counter() - t0) * 1000)
            validation = validate_markdown_sections(
                text,
                payload.output.required_sections,
                must_have_headings=_must_have_headings(payload),
            )
            status = "draft" if payload.output.must_follow_template and not validation.get("ok") else "completed"
            async with async_session_maker() as db2:
                _, output_id = await finalize_run(
                    db2,
                    run_id=run_id,
                    assistant_content=text,
                    status=status,
                    response_metadata=_response_meta(
                        payload,
                        used_skills=[workshop_skill],
                        execution_mode="direct",
                        tool_capture_hit=False,
                    ),
                    validation=validation,
                    error_message=None,
                    duration_ms=duration_ms,
                    project_id=payload.project.id,
                    scenario_id=payload.scenario.id,
                    template_id=payload.output.template_id,
                    save_output=payload.execution.save_output,
                    output_title=payload.scenario.name,
                    output_owner_id=effective_uid,
                )
            return JSONResponse(
                content={
                    "run_id": run_id,
                    "output_id": output_id,
                    "validation": validation,
                    "content": text,
                    "used_skills": [workshop_skill],
                    "execution_mode": "direct",
                }
            )

        async def workshop_direct_stream() -> AsyncGenerator[str, None]:
            t0 = time.perf_counter()
            try:
                text = await _run_workshop_direct_text(
                    workshop_skill,
                    user_text_ws,
                    eff_request.task_input,
                )
            except RuntimeError as exc:
                async with async_session_maker() as s:
                    await mark_run_failed(s, run_id, str(exc))
                yield sse_error_event(str(exc), code="workshop_direct_failed")
                return

            for line in text.splitlines(keepends=True):
                yield sse_openai_delta(line)

            duration_ms = int((time.perf_counter() - t0) * 1000)
            validation = validate_markdown_sections(
                text,
                payload.output.required_sections,
                must_have_headings=_must_have_headings(payload),
            )
            status = "draft" if payload.output.must_follow_template and not validation.get("ok") else "completed"
            output_id: str | None = None
            try:
                async with async_session_maker() as db2:
                    _, output_id = await finalize_run(
                        db2,
                        run_id=run_id,
                        assistant_content=text,
                        status=status,
                        response_metadata=_response_meta(
                            payload,
                            used_skills=[workshop_skill],
                            execution_mode="direct",
                            tool_capture_hit=False,
                        ),
                        validation=validation,
                        error_message=None,
                        duration_ms=duration_ms,
                        project_id=payload.project.id,
                        scenario_id=payload.scenario.id,
                        template_id=payload.output.template_id,
                        save_output=payload.execution.save_output,
                        output_title=payload.scenario.name,
                        output_owner_id=effective_uid,
                    )
            except Exception as exc:
                logger.exception("finalize_run failed run_id=%s err=%s", run_id, exc)

            meta = {
                "tphermes_task": {
                    "run_id": run_id,
                    "output_id": output_id,
                    "validation": validation,
                    "execution_mode": "direct",
                }
            }
            yield sse_meta_event(meta)

        return StreamingResponse(
            workshop_direct_stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    # chat 入口：显式单技能白名单时直接执行技能，避免 agent 未调 tool 或超时。
    # 共创 co_create 走 Hermes 基于项目+场景编排，不在此短路。
    if payload.entrypoint == "chat" and _chat_force_skill_mode(
        payload, chat_mode=eff_request.chat_mode
    ):
        forced_skill = payload.skills.allowed[0]
        logger.info(
            "chat forced skill direct run_id=%s skill=%s project_id=%s",
            run_id,
            forced_skill,
            eff_request.project_id,
        )
        if not eff_request.stream:
            t0 = time.perf_counter()
            try:
                text = await _run_workshop_direct_text(
                    forced_skill,
                    user_text,
                    eff_request.task_input,
                )
            except RuntimeError as exc:
                await mark_run_failed(db, run_id, str(exc))
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            duration_ms = int((time.perf_counter() - t0) * 1000)
            validation = validate_markdown_sections(
                text,
                payload.output.required_sections,
                must_have_headings=_must_have_headings(payload),
            )
            status = "draft" if payload.output.must_follow_template and not validation.get("ok") else "completed"
            async with async_session_maker() as db2:
                _, output_id = await finalize_run(
                    db2,
                    run_id=run_id,
                    assistant_content=text,
                    status=status,
                    response_metadata=_response_meta(
                        payload,
                        used_skills=[forced_skill],
                        execution_mode="direct_skill_forced",
                        tool_capture_hit=False,
                    ),
                    validation=validation,
                    error_message=None,
                    duration_ms=duration_ms,
                    project_id=payload.project.id,
                    scenario_id=payload.scenario.id,
                    template_id=payload.output.template_id,
                    save_output=payload.execution.save_output,
                    output_title=payload.scenario.name,
                    output_owner_id=effective_uid,
                )
            return JSONResponse(
                content={
                    "run_id": run_id,
                    "output_id": output_id,
                    "validation": validation,
                    "content": text,
                    "execution_mode": "direct_skill_forced",
                    "tool_capture_hit": False,
                    "used_skills": [forced_skill],
                }
            )

        async def chat_forced_skill_stream() -> AsyncGenerator[str, None]:
            t0 = time.perf_counter()
            try:
                text = await _run_workshop_direct_text(
                    forced_skill,
                    user_text,
                    eff_request.task_input,
                )
            except RuntimeError as exc:
                async with async_session_maker() as s:
                    await mark_run_failed(s, run_id, str(exc))
                yield sse_error_event(str(exc), code="chat_forced_skill_failed")
                return

            for line in text.splitlines(keepends=True):
                yield sse_openai_delta(line)

            duration_ms = int((time.perf_counter() - t0) * 1000)
            validation = validate_markdown_sections(
                text,
                payload.output.required_sections,
                must_have_headings=_must_have_headings(payload),
            )
            status = "draft" if payload.output.must_follow_template and not validation.get("ok") else "completed"
            output_id: str | None = None
            try:
                async with async_session_maker() as db2:
                    _, output_id = await finalize_run(
                        db2,
                        run_id=run_id,
                        assistant_content=text,
                        status=status,
                        response_metadata=_response_meta(
                            payload,
                            used_skills=[forced_skill],
                            execution_mode="direct_skill_forced",
                            tool_capture_hit=False,
                        ),
                        validation=validation,
                        error_message=None,
                        duration_ms=duration_ms,
                        project_id=payload.project.id,
                        scenario_id=payload.scenario.id,
                        template_id=payload.output.template_id,
                        save_output=payload.execution.save_output,
                        output_title=payload.scenario.name,
                        output_owner_id=effective_uid,
                    )
            except Exception as exc:
                logger.exception("finalize_run failed run_id=%s err=%s", run_id, exc)

            meta = {
                "tphermes_task": {
                    "run_id": run_id,
                    "output_id": output_id,
                    "validation": validation,
                    "execution_mode": "direct_skill_forced",
                    "tool_capture_hit": False,
                    "used_skills": [forced_skill],
                }
            }
            yield sse_meta_event(meta)

        return StreamingResponse(
            chat_forced_skill_stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    messages = _trim_chat_messages(merge_chat_messages(eff_request.messages, user_text))
    chat_lightweight = payload.entrypoint == "chat" and is_lightweight_chat_message(user_text)
    skip_kb_prefetch = payload.entrypoint == "chat" and should_skip_kb_prefetch_for_co_create_draft(
        user_text
    ) and (eff_request.co_create_agent_mode or "").strip() != "ask"
    kb_prefetch_timeout_sec = _env_float("KB_PREFETCH_TIMEOUT_SEC", 12.0, min_value=1.0, max_value=120.0)
    upstream_heartbeat_sec = _env_float(
        "CHAT_STREAM_HEARTBEAT_SEC",
        30.0,
        min_value=3.0,
        max_value=120.0,
    )
    agent_cold_start_ms = _env_int("CHAT_AGENT_COLD_START_MS", 8000, min_value=1000, max_value=120_000)

    async def _prefetch_kb_for_chat(progress_cb=None) -> tuple[str, int]:
        has_project = bool((eff_request.project_id or "").strip())
        if (
            chat_lightweight
            or (skip_kb_prefetch and not has_project)
            or not user_text.strip()
            or payload.entrypoint != "chat"
        ):
            return "", 0
        kb_cols = [c for c in payload.knowledge.collections if c]
        if not kb_cols and eff_request.project_id:
            kb_cols = merge_project_kb_collections([], eff_request.project_id)
        pf = await asyncio.wait_for(
            prefetch_kb_sources_for_run(
                run_id=run_id,
                project_id=eff_request.project_id,
                collections=kb_cols,
                query_text=user_text,
                progress_cb=progress_cb,
            ),
            timeout=kb_prefetch_timeout_sec,
        )
        logger.info(
            "kb prefetch complete run_id=%s sources=%s lightweight=%s",
            run_id,
            pf.source_count,
            chat_lightweight,
        )
        return pf.prompt_block, pf.source_count

    if not eff_request.stream:
        kb_prefetch_block, _ = await _prefetch_kb_for_chat()
        upstream_body = build_chat_completion_body(
            payload,
            messages,
            workshop_skill_name=workshop_skill if is_workshop else None,
            task_input=eff_request.task_input if is_workshop else None,
            kb_prefetch_block=kb_prefetch_block or None,
            lightweight_mode=chat_lightweight,
        )
        _apply_chat_generation_limits(upstream_body)
        upstream_body["stream"] = eff_request.stream
        target_url, api_key = _chat_target_required()
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        timeout = httpx.Timeout(connect=10.0, read=120.0, write=30.0, pool=10.0)
        t0 = time.perf_counter()
        try:
            async with _chat_client(timeout) as client:
                resp = await client.post(target_url, headers=headers, json=upstream_body)
        except httpx.HTTPError as exc:
            await mark_run_failed(db, run_id, str(exc))
            raise HTTPException(status_code=502, detail=f"Hermes-agent unavailable: {exc}") from exc

        text = ""
        if resp.status_code < 400:
            try:
                data = resp.json()
                choices = data.get("choices") or []
                if choices and isinstance(choices[0], dict):
                    msg = choices[0].get("message") or {}
                    if isinstance(msg.get("content"), str):
                        text = msg["content"]
            except Exception:
                text = resp.text

        duration_ms = int((time.perf_counter() - t0) * 1000)
        if resp.status_code >= 400:
            await mark_run_failed(db, run_id, resp.text[:2000])
            return JSONResponse(status_code=resp.status_code, content=_format_upstream_error(resp.status_code, resp.content))

        exec_mode = "agent"
        capture_hit = False
        used_skills: list[str] | None = None
        if is_workshop and workshop_skill:
            try:
                text, capture_hit, exec_mode = await _resolve_workshop_agent_output(
                    run_id=run_id,
                    sse_fallback=text,
                    skill_name=workshop_skill,
                    user_text=user_text,
                    task_input=eff_request.task_input,
                )
            except HTTPException as exc:
                await mark_run_failed(db, run_id, str(exc.detail))
                raise
            used_skills = [workshop_skill]
        elif payload.entrypoint == "chat":
            try:
                text, capture_hit, exec_mode, used_skills = await _resolve_chat_skill_output(
                    run_id=run_id,
                    payload=payload,
                    sse_fallback=text,
                    user_text=user_text,
                    task_input=eff_request.task_input,
                    chat_mode=eff_request.chat_mode,
                )
            except HTTPException as exc:
                await mark_run_failed(db, run_id, str(exc.detail))
                raise

        validation = validate_markdown_sections(
            text,
            payload.output.required_sections,
            must_have_headings=_must_have_headings(payload),
        )
        validation_ok = bool(validation.get("ok", True))
        status, stream_error = _resolve_run_status_and_error(
            text,
            must_follow_template=payload.output.must_follow_template,
            validation_ok=validation_ok,
        )

        async with async_session_maker() as db2:
            _, output_id = await finalize_run(
                db2,
                run_id=run_id,
                assistant_content=text,
                status=status,
                response_metadata=_response_meta(
                    payload,
                    used_skills=used_skills,
                    execution_mode=exec_mode if (is_workshop or used_skills or capture_hit) else None,
                    tool_capture_hit=capture_hit,
                ),
                validation=validation,
                error_message=stream_error,
                duration_ms=duration_ms,
                project_id=payload.project.id,
                scenario_id=payload.scenario.id,
                template_id=payload.output.template_id,
                save_output=payload.execution.save_output,
                output_title=payload.scenario.name,
                output_owner_id=effective_uid,
            )

        body: dict[str, Any] = {
            "run_id": run_id,
            "output_id": output_id,
            "validation": validation,
            "content": text,
        }
        if is_workshop:
            body["execution_mode"] = exec_mode
            body["tool_capture_hit"] = capture_hit
            if used_skills:
                body["used_skills"] = used_skills
        elif used_skills or capture_hit:
            body["execution_mode"] = exec_mode
            body["tool_capture_hit"] = capture_hit
            body["used_skills"] = used_skills or []
        return JSONResponse(content=body)

    async def event_stream() -> AsyncGenerator[str, None]:
        kb_prefetch_block = ""
        kb_prefetch_count = 0
        if skip_kb_prefetch and user_text.strip():
            yield sse_meta_event({"tphermes_task": {"phase": "co_create_draft", "run_id": run_id}})
        should_kb_prefetch = (
            payload.entrypoint == "chat"
            and not chat_lightweight
            and user_text.strip()
            and (not skip_kb_prefetch or bool((eff_request.project_id or "").strip()))
        )
        if should_kb_prefetch:
            async def emit_prefetch_progress(phase: str, extra: dict[str, Any] | None = None) -> None:
                meta = {"phase": phase, "run_id": run_id}
                if extra:
                    meta.update(extra)
                await progress_queue.put(meta)

            progress_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
            prefetch_task = asyncio.create_task(
                _prefetch_kb_for_chat(progress_cb=emit_prefetch_progress)
            )
            yield sse_meta_event({"tphermes_task": {"phase": "kb_prefetch", "run_id": run_id}})
            try:
                while True:
                    if prefetch_task.done() and progress_queue.empty():
                        break
                    try:
                        meta = await asyncio.wait_for(
                            progress_queue.get(),
                            timeout=min(2.0, kb_prefetch_timeout_sec),
                        )
                    except TimeoutError:
                        if prefetch_task.done():
                            break
                        yield sse_meta_event(
                            {
                                "tphermes_task": {
                                    "phase": "kb_prefetch_heartbeat",
                                    "run_id": run_id,
                                }
                            }
                        )
                        continue
                    yield sse_meta_event({"tphermes_task": meta})
                kb_prefetch_block, kb_prefetch_count = await prefetch_task
            except TimeoutError:
                logger.warning(
                    "kb prefetch degraded by timeout run_id=%s timeout=%s",
                    run_id,
                    kb_prefetch_timeout_sec,
                )
                prefetch_task.cancel()
                yield sse_meta_event(
                    {
                        "tphermes_task": {
                            "phase": "kb_prefetch_timeout",
                            "run_id": run_id,
                            "timeout_sec": kb_prefetch_timeout_sec,
                        }
                    }
                )
                kb_prefetch_block, kb_prefetch_count = "", 0
            finally:
                while not progress_queue.empty():
                    try:
                        meta = progress_queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                    yield sse_meta_event({"tphermes_task": meta})

        upstream_body = build_chat_completion_body(
            payload,
            messages,
            workshop_skill_name=workshop_skill if is_workshop else None,
            task_input=eff_request.task_input if is_workshop else None,
            kb_prefetch_block=kb_prefetch_block or None,
            lightweight_mode=chat_lightweight,
        )
        _apply_chat_generation_limits(upstream_body)
        upstream_body["stream"] = True

        yield sse_meta_event(
            {
                "tphermes_task": {
                    "phase": "agent_generating",
                    "run_id": run_id,
                    "kb_prefetch_count": kb_prefetch_count,
                    "lightweight": chat_lightweight,
                }
            }
        )

        target_url, api_key = _chat_target_required()
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        timeout = httpx.Timeout(connect=10.0, read=300.0, write=30.0, pool=10.0)
        t0 = time.perf_counter()
        full_text = ""
        sse_buffer = ""
        tool_events: list[dict[str, Any]] = []
        try:
            async with _chat_client(timeout) as client:
                async with client.stream("POST", target_url, headers=headers, json=upstream_body) as resp:
                    if resp.status_code >= 400:
                        detail = await resp.aread()
                        async with async_session_maker() as s:
                            await mark_run_failed(s, run_id, f"upstream HTTP {resp.status_code}")
                        yield "data: " + json.dumps(
                            _format_upstream_error(resp.status_code, detail),
                            ensure_ascii=False,
                        ) + "\n\n"
                        return

                    chunk_iter = resp.aiter_text()
                    first_chunk_seen = False
                    last_chunk_at = time.perf_counter()
                    while True:
                        try:
                            chunk = await asyncio.wait_for(
                                anext(chunk_iter),
                                timeout=upstream_heartbeat_sec,
                            )
                        except StopAsyncIteration:
                            break
                        except TimeoutError:
                            waiting_ms = int((time.perf_counter() - last_chunk_at) * 1000)
                            if not first_chunk_seen and waiting_ms >= agent_cold_start_ms:
                                phase = "agent_cold_start"
                            elif not first_chunk_seen:
                                phase = "agent_waiting_first_token"
                            else:
                                phase = "agent_streaming"
                            yield sse_meta_event(
                                {
                                    "tphermes_task": {
                                        "phase": phase,
                                        "run_id": run_id,
                                        "waiting_ms": waiting_ms,
                                    }
                                }
                            )
                            continue
                        if not chunk:
                            continue
                        first_chunk_seen = True
                        last_chunk_at = time.perf_counter()
                        yield chunk
                        sse_buffer += chunk
                        blocks, sse_buffer = _extract_sse_blocks(sse_buffer)
                        for block in blocks:
                            parsed_block = _parse_sse_block(block)
                            if not parsed_block:
                                continue
                            event_name, data = parsed_block
                            if event_name == "hermes.tool.progress":
                                tool_event = _parse_file_tool_event(data)
                                if tool_event:
                                    tool_events = _merge_tool_event_rows(tool_events, tool_event)
                                    yield sse_meta_event(
                                        {
                                            "tphermes_task": {
                                                "run_id": run_id,
                                                "tool_events": [tool_event],
                                            }
                                        }
                                    )
                                continue
                            delta, parsed = parse_sse_data_line(data)
                            if parsed and parsed.get("error"):
                                continue
                            if delta:
                                full_text += delta
                    if sse_buffer.strip():
                        parsed_block = _parse_sse_block(sse_buffer)
                        if parsed_block:
                            event_name, data = parsed_block
                            if event_name == "hermes.tool.progress":
                                tool_event = _parse_file_tool_event(data)
                                if tool_event:
                                    tool_events = _merge_tool_event_rows(tool_events, tool_event)
                                    yield sse_meta_event(
                                        {
                                            "tphermes_task": {
                                                "run_id": run_id,
                                                "tool_events": [tool_event],
                                            }
                                        }
                                    )
                            else:
                                delta, parsed = parse_sse_data_line(data)
                                if not (parsed and parsed.get("error")) and delta:
                                    full_text += delta
        except httpx.HTTPError as exc:
            async with async_session_maker() as s:
                await mark_run_failed(s, run_id, str(exc))
            yield (
                'data: {"error":{"message":"Hermes-agent unavailable: '
                + str(exc).replace('"', '\\"')
                + '"}}\n\n'
            )
            return

        duration_ms = int((time.perf_counter() - t0) * 1000)
        finalize_text = full_text
        exec_mode = "agent"
        capture_hit = False
        used_skills: list[str] | None = None

        if is_workshop and workshop_skill:
            try:
                finalize_text, capture_hit, exec_mode = await _resolve_workshop_agent_output(
                    run_id=run_id,
                    sse_fallback=full_text,
                    skill_name=workshop_skill,
                    user_text=user_text,
                    task_input=eff_request.task_input,
                )
            except HTTPException as exc:
                async with async_session_maker() as s:
                    await mark_run_failed(s, run_id, str(exc.detail))
                yield "data: " + json.dumps({"error": {"message": exc.detail}}, ensure_ascii=False) + "\n\n"
                return
            used_skills = [workshop_skill]
            if finalize_text.strip() and finalize_text != full_text:
                for line in finalize_text.splitlines(keepends=True):
                    yield sse_openai_delta(line)
        elif payload.entrypoint == "chat":
            try:
                finalize_text, capture_hit, exec_mode, used_skills = await _resolve_chat_skill_output(
                    run_id=run_id,
                    payload=payload,
                    sse_fallback=full_text,
                    user_text=user_text,
                    task_input=eff_request.task_input,
                    chat_mode=eff_request.chat_mode,
                )
            except HTTPException as exc:
                async with async_session_maker() as s:
                    await mark_run_failed(s, run_id, str(exc.detail))
                yield "data: " + json.dumps({"error": {"message": exc.detail}}, ensure_ascii=False) + "\n\n"
                return
            if finalize_text.strip() and finalize_text != full_text:
                for line in finalize_text.splitlines(keepends=True):
                    yield sse_openai_delta(line)

        validation = validate_markdown_sections(
            finalize_text,
            payload.output.required_sections,
            must_have_headings=_must_have_headings(payload),
        )
        sources_payload = await build_sources_for_sse(run_id, finalize_text)
        if sources_payload.get("unresolved_refs"):
            validation = {
                **validation,
                "citations_ok": False,
                "unresolved_refs": sources_payload.get("unresolved_refs") or [],
            }
        elif sources_payload.get("sources"):
            validation = {**validation, "citations_ok": True}

        validation_ok = bool(validation.get("ok", True))
        status, stream_error = _resolve_run_status_and_error(
            finalize_text,
            must_follow_template=payload.output.must_follow_template,
            validation_ok=validation_ok,
        )
        if stream_error:
            logger.warning(
                "chat stream empty assistant_content run_id=%s duration_ms=%s",
                run_id,
                duration_ms,
            )

        citations_json_str = (
            json.dumps(sources_payload, ensure_ascii=False)
            if sources_payload.get("sources")
            else None
        )

        output_id: str | None = None
        try:
            async with async_session_maker() as db2:
                _, output_id = await finalize_run(
                    db2,
                    run_id=run_id,
                    assistant_content=finalize_text,
                    status=status,
                    response_metadata=_response_meta(
                        payload,
                        used_skills=used_skills,
                        execution_mode=exec_mode if (is_workshop or used_skills or capture_hit) else None,
                        tool_capture_hit=capture_hit,
                        citations_meta=sources_payload,
                    ),
                    validation=validation,
                    error_message=stream_error,
                    duration_ms=duration_ms,
                    project_id=payload.project.id,
                    scenario_id=payload.scenario.id,
                    template_id=payload.output.template_id,
                    save_output=payload.execution.save_output,
                    output_title=payload.scenario.name,
                    output_owner_id=effective_uid,
                    citations_json=citations_json_str,
                )
        except Exception as exc:
            logger.exception("finalize_run failed run_id=%s err=%s", run_id, exc)

        meta: dict[str, Any] = {
            "tphermes_task": {
                "run_id": run_id,
                "output_id": output_id,
                "validation": validation,
                "status": status,
            },
            "tphermes_sources": sources_payload,
        }
        if stream_error:
            meta["tphermes_task"]["empty_content"] = True
            meta["tphermes_task"]["stream_error"] = stream_error
        from backend.services.file_action_service import parse_file_actions_from_content

        parsed_actions = parse_file_actions_from_content(finalize_text)
        if parsed_actions:
            meta["tphermes_task"]["file_actions"] = parsed_actions
            logger.info("[co-create] stream file_actions count=%s run_id=%s", len(parsed_actions), run_id)
        if tool_events:
            meta["tphermes_task"]["tool_events"] = tool_events
        if is_workshop:
            meta["tphermes_task"]["execution_mode"] = exec_mode
            meta["tphermes_task"]["tool_capture_hit"] = capture_hit
            if used_skills:
                meta["tphermes_task"]["used_skills"] = used_skills
        elif used_skills or capture_hit:
            meta["tphermes_task"]["execution_mode"] = exec_mode
            meta["tphermes_task"]["tool_capture_hit"] = capture_hit
            meta["tphermes_task"]["used_skills"] = used_skills or []
        yield "data: " + json.dumps(meta, ensure_ascii=False) + "\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


class RunDetailResponse(BaseModel):
    id: str
    project_id: str | None
    scenario_id: str | None = None
    entrypoint: str
    status: str
    snapshot: dict[str, Any] | None
    response_metadata: dict[str, Any] | None
    validation: dict[str, Any] | None
    assistant_content: str | None
    error_message: str | None
    duration_ms: int | None
    created_at: str | None
    kb_sources: dict[str, Any] | None = None


@runs_router.get("/{run_id}", response_model=RunDetailResponse)
async def get_run(run_id: str, db: AsyncSession = Depends(get_db)):
    row = await db.get(OrchestrationRun, run_id)
    if not row:
        raise HTTPException(status_code=404, detail="run not found")

    def _loads(raw: str | None) -> dict[str, Any] | None:
        if not raw:
            return None
        try:
            v = json.loads(raw)
            return v if isinstance(v, dict) else None
        except json.JSONDecodeError:
            return None

    capture = await load_kb_sources(db, run_id)
    kb_sources = build_sources_payload_from_capture(capture, row.assistant_content or "")

    return RunDetailResponse(
        id=row.id,
        project_id=row.project_id,
        scenario_id=getattr(row, "scenario_id", None),
        entrypoint=row.entrypoint,
        status=row.status,
        snapshot=_loads(row.snapshot_json),
        response_metadata=_loads(row.response_metadata_json),
        validation=_loads(row.validation_json),
        assistant_content=row.assistant_content,
        error_message=row.error_message,
        duration_ms=row.duration_ms,
        created_at=row.created_at,
        kb_sources=kb_sources if kb_sources.get("sources") else None,
    )
