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
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import get_db, async_session_maker
from backend.models.orchestration_run import OrchestrationRun
from backend.models.output_asset import OutputAsset
from backend.schemas.orchestration import OrchestrationPayload, TaskExecuteRequest, TaskInputPayload
from backend.services.agent_gateway import build_chat_completion_body, parse_sse_data_line
from backend.services.orchestration_service import (
    ProjectNotFoundError,
    ScenarioVersionMismatchError,
    WorkshopBindingError,
    assemble_payload,
    merge_chat_messages,
)
from backend.services.run_log_service import create_run, finalize_run, mark_run_failed
from backend.services.skill_loader import get_loader
from backend.services.template_service import extract_required_sections, get_template_by_id, validate_markdown_sections
from backend.services.workshop_task_runner import (
    _parse_workshop_context,
    run_workshop_skill_async,
    sse_openai_delta,
)

logger = logging.getLogger("tpdx.hermes")

router = APIRouter(prefix="/tasks", tags=["tasks"])
runs_router = APIRouter(prefix="/runs", tags=["runs"])


def _chat_target() -> tuple[str, str]:
    url = os.getenv("HERMES_CHAT_API_URL", "").strip()
    if not url:
        raise RuntimeError(
            "HERMES_CHAT_API_URL environment variable is not set. "
            "Cannot proxy chat requests without a configured upstream URL."
        )
    api_key = os.getenv("HERMES_CHAT_API_KEY", "").strip()
    return url, api_key


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


def _response_meta(payload: OrchestrationPayload, *, used_skills: list[str] | None = None) -> dict[str, Any]:
    return {
        "used_skills": used_skills or [],
        "used_collections": [],
        "skills_policy": payload.skills.model_dump(),
        "skills_violations": [],
    }


@router.post("/execute")
async def execute_task(request: TaskExecuteRequest, db: AsyncSession = Depends(get_db)):
    eff_request = request
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
        material = (src_row.content or "").strip()
        ti = eff_request.task_input
        if not material:
            raise HTTPException(status_code=400, detail="来源输出正文为空，无法优化")
        if ti is None:
            eff_request = eff_request.model_copy(update={"task_input": TaskInputPayload(source_material=material)})
        elif not (ti.source_material and str(ti.source_material).strip()):
            eff_request = eff_request.model_copy(
                update={"task_input": ti.model_copy(update={"source_material": material})},
            )

    try:
        payload, snapshot = await assemble_payload(db, eff_request)
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
        request_json=eff_request.model_dump_json(),
        snapshot_json=json.dumps(snapshot, ensure_ascii=False),
        skills_policy_json=json.dumps(payload.skills.model_dump(), ensure_ascii=False),
    )

    if eff_request.entrypoint == "workshop":
        skill_name = payload.skills.allowed[0]
        context = _parse_workshop_context(user_text)
        # Inject structured task_input so the skill can access individual fields
        if eff_request.task_input is not None:
            context["task_input"] = eff_request.task_input.model_dump(exclude_none=True)

        def _must_head_ws() -> bool:
            vr = payload.output.validation_rules
            return True if vr is None else bool(vr.must_have_headings)

        if not eff_request.stream:
            t0 = time.perf_counter()
            try:
                text = await run_workshop_skill_async(skill_name, context)
            except RuntimeError as exc:
                await mark_run_failed(db, run_id, str(exc))
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            duration_ms = int((time.perf_counter() - t0) * 1000)
            validation = validate_markdown_sections(
                text,
                payload.output.required_sections,
                must_have_headings=_must_head_ws(),
            )
            status = "draft" if payload.output.must_follow_template and not validation.get("ok") else "completed"
            async with async_session_maker() as db2:
                _, output_id = await finalize_run(
                    db2,
                    run_id=run_id,
                    assistant_content=text,
                    status=status,
                    response_metadata=_response_meta(payload, used_skills=[skill_name]),
                    validation=validation,
                    error_message=None,
                    duration_ms=duration_ms,
                    project_id=payload.project.id,
                    scenario_id=payload.scenario.id,
                    template_id=payload.output.template_id,
                    save_output=payload.execution.save_output,
                    output_title=payload.scenario.name,
                )
            return JSONResponse(
                content={
                    "run_id": run_id,
                    "output_id": output_id,
                    "validation": validation,
                    "content": text,
                    "used_skills": [skill_name],
                }
            )

        async def workshop_event_stream() -> AsyncGenerator[str, None]:
            t0 = time.perf_counter()
            try:
                text = await run_workshop_skill_async(skill_name, context)
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
                must_have_headings=_must_head_ws(),
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
                        response_metadata=_response_meta(payload, used_skills=[skill_name]),
                        validation=validation,
                        error_message=None,
                        duration_ms=duration_ms,
                        project_id=payload.project.id,
                        scenario_id=payload.scenario.id,
                        template_id=payload.output.template_id,
                        save_output=payload.execution.save_output,
                        output_title=payload.scenario.name,
                    )
            except Exception as exc:
                logger.exception("finalize_run failed run_id=%s err=%s", run_id, exc)

            meta = {"tphermes_task": {"run_id": run_id, "output_id": output_id, "validation": validation}}
            yield "data: " + json.dumps(meta, ensure_ascii=False) + "\n\n"

        return StreamingResponse(
            workshop_event_stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    messages = merge_chat_messages(eff_request.messages, user_text)
    upstream_body = build_chat_completion_body(payload, messages)
    upstream_body["stream"] = eff_request.stream

    if not eff_request.stream:
        target_url, api_key = _chat_target()
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

        def _must_have_headings_ns() -> bool:
            vr = payload.output.validation_rules
            return True if vr is None else bool(vr.must_have_headings)

        validation = validate_markdown_sections(
            text,
            payload.output.required_sections,
            must_have_headings=_must_have_headings_ns(),
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
                response_metadata=_response_meta(payload),
                validation=validation,
                error_message=None,
                duration_ms=duration_ms,
                project_id=payload.project.id,
                scenario_id=payload.scenario.id,
                template_id=payload.output.template_id,
                save_output=payload.execution.save_output,
                output_title=payload.scenario.name,
            )

        return JSONResponse(
            content={
                "run_id": run_id,
                "output_id": output_id,
                "validation": validation,
                "content": text,
            }
        )

    def _must_have_headings() -> bool:
        vr = payload.output.validation_rules
        return True if vr is None else bool(vr.must_have_headings)

    async def event_stream() -> AsyncGenerator[str, None]:
        target_url, api_key = _chat_target()
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
        validation = validate_markdown_sections(
            full_text,
            payload.output.required_sections,
            must_have_headings=_must_have_headings(),
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
                    assistant_content=full_text,
                    status=status,
                    response_metadata=_response_meta(payload),
                    validation=validation,
                    error_message=None,
                    duration_ms=duration_ms,
                    project_id=payload.project.id,
                    scenario_id=payload.scenario.id,
                    template_id=payload.output.template_id,
                    save_output=payload.execution.save_output,
                    output_title=payload.scenario.name,
                )
        except Exception as exc:
            logger.exception("finalize_run failed run_id=%s err=%s", run_id, exc)

        meta = {"tphermes_task": {"run_id": run_id, "output_id": output_id, "validation": validation}}
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
