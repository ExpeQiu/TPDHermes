"""
统一编排任务入口：POST /tasks/execute，GET /runs/{run_id}
"""

from __future__ import annotations

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
from backend.services.agent_gateway import build_chat_completion_body, parse_sse_data_line
from backend.services.orchestration_service import (
    ProjectNotFoundError,
    ScenarioVersionMismatchError,
    WorkshopBindingError,
    assemble_payload,
    merge_chat_messages,
)
from backend.services.project_kb import output_doc_id, project_kb_collection
from backend.services.project_kb_ingest import schedule_ingest_output
from backend.services.project_access import require_project_for_user
from backend.services.run_log_service import create_run, finalize_run, mark_run_failed
from backend.services.skill_loader import get_loader
from backend.services.template_service import extract_required_sections, get_template_by_id, validate_markdown_sections
from backend.services.workshop_task_runner import (
    _parse_workshop_context,
    run_workshop_skill_async,
    sse_openai_delta,
)
from backend.services.workshop_execution import (
    primary_text_from_capture,
    workshop_agent_fallback_direct,
    workshop_execution_mode,
)
from backend.services.workshop_tool_capture import load_workshop_tool_capture
from backend.services.user_identity import effective_user_id_for_api, viewer_role

logger = logging.getLogger("tpdx.hermes")

router = APIRouter(prefix="/tasks", tags=["tasks"])
runs_router = APIRouter(prefix="/runs", tags=["runs"])


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


async def _validate_task_request(db: AsyncSession, request: TaskExecuteRequest, payload: OrchestrationPayload) -> None:
    if request.entrypoint == "workshop":
        allowed = payload.skills.allowed
        if not allowed:
            raise HTTPException(
                status_code=400,
                detail="工坊入口需要有效的技能白名单：请在场景编排中配置 skills_policy.allowed，或在请求中提供 overrides.skills.allowed。",
            )
        loader = get_loader()
        names = set(loader.discover())
        for name in allowed:
            if name not in names:
                raise HTTPException(status_code=400, detail=f"技能不在可用列表: {name}")

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
) -> dict[str, Any]:
    meta: dict[str, Any] = {
        "used_skills": used_skills or [],
        "used_collections": [],
        "skills_policy": payload.skills.model_dump(),
        "skills_violations": [],
    }
    if execution_mode:
        meta["execution_mode"] = execution_mode
    if payload.entrypoint == "workshop":
        meta["tool_capture_hit"] = tool_capture_hit
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
            "workshop agent capture miss run_id=%s fallback=direct skill=%s",
            run_id,
            skill_name,
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


@router.post("/execute")
async def execute_task(req: Request, task_req: TaskExecuteRequest, db: AsyncSession = Depends(get_db)):
    effective_uid = effective_user_id_for_api(req, body_user_id=task_req.user_id)
    actor_role = (task_req.user_role or "").strip() or viewer_role(req)
    logger.info(
        "tasks execute user_id=%s entrypoint=%s project_id=%s",
        effective_uid[:24],
        task_req.entrypoint,
        task_req.project_id,
    )
    eff_request = task_req
    refine_full_source = os.getenv("WORKSHOP_REFINE_FULL_SOURCE", "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )
    if (
        eff_request.entrypoint == "workshop"
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
        if refine_full_source:
            material = (src_row.content or "").strip()
            ti = eff_request.task_input
            if not material:
                raise HTTPException(status_code=400, detail="来源输出正文为空，无法优化")
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

    user_text = payload.user_input.message

    tpl_sections: list[str] = []
    if payload.output.template_id:
        tpl = await get_template_by_id(db, payload.output.template_id)
        if tpl:
            tpl_sections = extract_required_sections(tpl)
            payload = _merge_required_sections(payload, tpl_sections)

    await _validate_task_request(db, eff_request, payload)

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
                yield "data: " + json.dumps({"error": {"message": str(exc)}}, ensure_ascii=False) + "\n\n"
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
            yield "data: " + json.dumps(meta, ensure_ascii=False) + "\n\n"

        return StreamingResponse(
            workshop_direct_stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    messages = merge_chat_messages(eff_request.messages, user_text)
    upstream_body = build_chat_completion_body(
        payload,
        messages,
        workshop_skill_name=workshop_skill if is_workshop else None,
        task_input=eff_request.task_input if is_workshop else None,
    )
    upstream_body["stream"] = eff_request.stream

    if not eff_request.stream:
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

        validation = validate_markdown_sections(
            text,
            payload.output.required_sections,
            must_have_headings=_must_have_headings(payload),
        )
        if payload.output.must_follow_template and not validation.get("ok"):
            status = "draft"
        else:
            status = "completed"

        async with async_session_maker() as db2:
            _, output_id = await finalize_run(
                db2,
                run_id=run_id,
                assistant_content=text,
                status=status,
                response_metadata=_response_meta(
                    payload,
                    used_skills=used_skills,
                    execution_mode=exec_mode if is_workshop else None,
                    tool_capture_hit=capture_hit,
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
        return JSONResponse(content=body)

    async def event_stream() -> AsyncGenerator[str, None]:
        target_url, api_key = _chat_target_required()
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        timeout = httpx.Timeout(connect=10.0, read=300.0, write=30.0, pool=10.0)
        t0 = time.perf_counter()
        full_text = ""
        sse_buffer = ""
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

                    async for chunk in resp.aiter_text():
                        if not chunk:
                            continue
                        yield chunk
                        sse_buffer += chunk
                        lines = sse_buffer.split("\n")
                        sse_buffer = lines.pop() or ""
                        for line in lines:
                            if not line.startswith("data: "):
                                continue
                            data = line[6:].strip()
                            delta, parsed = parse_sse_data_line(data)
                            if parsed and parsed.get("error"):
                                continue
                            if delta:
                                full_text += delta
                    if sse_buffer.strip():
                        for line in sse_buffer.split("\n"):
                            if not line.startswith("data: "):
                                continue
                            data = line[6:].strip()
                            delta, parsed = parse_sse_data_line(data)
                            if parsed and parsed.get("error"):
                                continue
                            if delta:
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

        validation = validate_markdown_sections(
            finalize_text,
            payload.output.required_sections,
            must_have_headings=_must_have_headings(payload),
        )
        status = "completed"
        if payload.output.must_follow_template and not validation.get("ok"):
            status = "draft"

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
                        execution_mode=exec_mode if is_workshop else None,
                        tool_capture_hit=capture_hit,
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

        meta: dict[str, Any] = {
            "tphermes_task": {
                "run_id": run_id,
                "output_id": output_id,
                "validation": validation,
            }
        }
        if is_workshop:
            meta["tphermes_task"]["execution_mode"] = exec_mode
            meta["tphermes_task"]["tool_capture_hit"] = capture_hit
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
    )
