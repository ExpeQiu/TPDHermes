"""工坊编排执行与 SSE 事件帮助方法。"""

from __future__ import annotations

import json
import logging
import time
import uuid
from dataclasses import dataclass
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
    parsed: dict[str, Any] | None = None
    try:
        data = json.loads(user_message)
        if isinstance(data, dict):
            parsed = dict(data)
    except (json.JSONDecodeError, TypeError):
        parsed = None
    context = parsed if parsed is not None else {"_raw_user_message": user_message}
    if not str(context.get("user_message") or "").strip():
        context["user_message"] = user_message
    return context


@dataclass(slots=True)
class WorkshopSkillOutcome:
    text: str
    status: str
    skill_name: str
    skill_version: str
    package_fingerprint: str
    version_pinned: bool
    execution_type: str | None
    execution_source: str | None
    fallback_reason: str | None
    duration_ms: int

    def call_record(self, *, call_kind: str | None = None) -> dict[str, Any]:
        status = self.status
        if call_kind is None:
            if status == "degraded":
                call_kind = "delivered_degraded"
            elif status == "failed":
                call_kind = "attempt_failed"
            else:
                call_kind = "delivered"
        return {
            "call_id": uuid.uuid4().hex,
            "skill_name": self.skill_name,
            "version": self.skill_version,
            "package_fingerprint": self.package_fingerprint,
            "version_pinned": self.version_pinned,
            "execution_type": self.execution_type,
            "execution_source": self.execution_source,
            "status": status,
            "call_kind": call_kind,
            "fallback_reason": self.fallback_reason,
            "duration_ms": self.duration_ms,
        }


def sse_content_replace(content: str, *, delivery: dict[str, Any] | None = None) -> str:
    """用整段替换已显示正文，避免在 Agent 文本后再追加一份成稿。"""
    task: dict[str, Any] = {
        "content_replace": content,
        "phase": "content_replace",
    }
    if delivery:
        phase = delivery.get("phase")
        if isinstance(phase, str) and phase.strip():
            task["phase"] = phase
        status = delivery.get("status") or delivery.get("delivery_status")
        if status:
            task["delivery_status"] = status
        reason = delivery.get("fallback_reason")
        if reason:
            task["fallback_reason"] = reason
        mode = delivery.get("execution_mode")
        if mode:
            task["execution_mode"] = mode
    return f"data: {json.dumps({'tphermes_task': task}, ensure_ascii=False)}\n\n"


def sse_openai_delta(content: str) -> str:
    payload = {"choices": [{"index": 0, "delta": {"content": content}}]}
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def sse_error_event(message: str, *, code: str = "workshop_error") -> str:
    payload = {"error": {"message": message, "code": code}}
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def sse_meta_event(meta: dict[str, Any]) -> str:
    return f"data: {json.dumps(meta, ensure_ascii=False)}\n\n"


async def run_workshop_skill_outcome(skill_name: str, context: dict[str, Any]) -> WorkshopSkillOutcome:
    loader = get_loader()
    try:
        skill = loader.load(skill_name)
    except SkillNotFoundError as e:
        raise RuntimeError(f"Skill not found: {skill_name}") from e
    except SkillLoadError as e:
        raise RuntimeError(f"Skill load error: {e}") from e

    started = time.perf_counter()
    result = await execute_workshop_skill_generate(skill, context)
    duration_ms = int((time.perf_counter() - started) * 1000)
    if isinstance(result, dict) and (
        result.get("success") is False or result.get("status") == "failed"
    ):
        logger.warning(
            "workshop skill failed skill=%s version=%s err=%s duration_ms=%s",
            skill_name,
            getattr(skill, "loaded_version", ""),
            result.get("error"),
            duration_ms,
        )
        raise RuntimeError(str(result.get("error") or f"Skill failed: {skill_name}"))

    text = _skill_result_to_text(result)
    status = "succeeded"
    fallback_reason = None
    execution_type = None
    execution_source = None
    if isinstance(result, dict):
        raw_status = str(result.get("status") or "").strip()
        if raw_status == "degraded":
            status = "degraded"
        fallback_reason = result.get("fallback_reason")
        execution_type = result.get("execution_type")
        execution_source = result.get("execution_source")
    if status == "degraded":
        logger.warning(
            "workshop skill degraded skill=%s version=%s reason=%s execution_type=%s duration_ms=%s",
            skill_name,
            getattr(skill, "loaded_version", ""),
            fallback_reason,
            execution_type,
            duration_ms,
        )
    else:
        logger.info(
            "workshop_direct skill=%s version=%s pinned=%s result_len=%s duration_ms=%s",
            skill_name,
            getattr(skill, "loaded_version", ""),
            getattr(skill, "version_pinned", False),
            len(text),
            duration_ms,
        )
    return WorkshopSkillOutcome(
        text=text,
        status=status,
        skill_name=skill_name,
        skill_version=str(getattr(skill, "loaded_version", "") or "unknown"),
        package_fingerprint=str(getattr(skill, "package_fingerprint", "") or ""),
        version_pinned=bool(getattr(skill, "version_pinned", False)),
        execution_type=str(execution_type) if execution_type else None,
        execution_source=str(execution_source) if execution_source else None,
        fallback_reason=str(fallback_reason) if fallback_reason else None,
        duration_ms=duration_ms,
    )


async def run_workshop_skill_async(skill_name: str, context: dict[str, Any]) -> str:
    return (await run_workshop_skill_outcome(skill_name, context)).text


async def stream_workshop_as_openai_sse(
    skill_name: str,
    context: dict[str, Any],
    *,
    line_chunk: bool = True,
) -> AsyncGenerator[str, None]:
    """直连技能一次给出最终正文，不把分片伪装成模型逐字生成。"""
    del line_chunk
    outcome = await run_workshop_skill_outcome(skill_name, context)
    yield sse_content_replace(
        outcome.text,
        delivery={
            "phase": "direct_delivery",
            "status": outcome.status,
            "fallback_reason": outcome.fallback_reason,
        },
    )
