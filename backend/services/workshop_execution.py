"""工坊执行模式与 tool capture 解析。"""
from __future__ import annotations

import json
import os
from typing import Any


def workshop_execution_mode() -> str:
    raw = os.getenv("WORKSHOP_EXECUTION_MODE", "agent").strip().lower()
    return "direct" if raw == "direct" else "agent"


def workshop_agent_strict_no_fallback() -> bool:
    """为 true 时 Agent 未命中 tool capture 即返回 424，不直连降级。"""
    return os.getenv("WORKSHOP_AGENT_STRICT", "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def workshop_agent_fallback_direct() -> bool:
    """
    Agent 未调用 workshop 工具时是否直连 skill.generate 降级。

    默认开启（与 chat 单技能白名单一致）；WORKSHOP_AGENT_STRICT=true 关闭降级。
    """
    if workshop_agent_strict_no_fallback():
        return False
    raw = os.getenv("WORKSHOP_AGENT_FALLBACK_DIRECT", "true").strip().lower()
    return raw not in ("0", "false", "no", "off")


def _stringify_content(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        inner = value.get("content")
        if isinstance(inner, str) and inner.strip():
            return inner.strip()
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


def skills_from_capture(capture: dict[str, Any] | None) -> list[str]:
    """从实际工具捕获推导已执行技能，不使用允许名单推测。"""
    names: list[str] = []
    artifacts = (capture or {}).get("artifacts")
    if not isinstance(artifacts, list):
        return names
    for item in artifacts:
        if not isinstance(item, dict):
            continue
        raw = item.get("raw") if isinstance(item.get("raw"), dict) else {}
        if raw.get("success") is False or raw.get("status") in ("failed", "rejected"):
            continue
        name = str(item.get("skill") or raw.get("skill") or "").strip()
        if name and name not in names:
            names.append(name)
    return names


def skill_calls_from_capture(capture: dict[str, Any] | None) -> list[dict[str, Any]]:
    """从工具捕获还原调用顺序，区分拒绝、失败、降级交付和成功交付。"""
    calls: list[dict[str, Any]] = []
    artifacts = (capture or {}).get("artifacts")
    if not isinstance(artifacts, list):
        return calls
    for index, item in enumerate(artifacts, start=1):
        if not isinstance(item, dict):
            continue
        raw = item.get("raw") if isinstance(item.get("raw"), dict) else {}
        content = raw.get("content") if isinstance(raw.get("content"), dict) else {}
        status = str(raw.get("status") or content.get("status") or "").strip()
        if not status:
            status = "failed" if raw.get("success") is False else "succeeded"
        if status == "rejected":
            call_kind = "attempt_rejected"
        elif status == "failed":
            call_kind = "attempt_failed"
        elif status == "degraded":
            call_kind = "delivered_degraded"
        else:
            call_kind = "delivered"
        calls.append(
            {
                "seq": index,
                "skill_name": str(item.get("skill") or raw.get("skill") or content.get("skill") or ""),
                "version": str(content.get("skill_version") or raw.get("skill_version") or ""),
                "package_fingerprint": str(
                    content.get("package_fingerprint") or raw.get("package_fingerprint") or ""
                ),
                "version_pinned": bool(content.get("version_pinned") or raw.get("version_pinned")),
                "execution_type": str(content.get("execution_type") or raw.get("execution_type") or ""),
                "status": status,
                "call_kind": call_kind,
                "fallback_reason": content.get("fallback_reason") or raw.get("fallback_reason"),
            }
        )
    return calls


def skill_violations_from_capture(capture: dict[str, Any] | None) -> list[dict[str, str]]:
    violations: list[dict[str, str]] = []
    artifacts = (capture or {}).get("artifacts")
    if not isinstance(artifacts, list):
        return violations
    for item in artifacts:
        if not isinstance(item, dict):
            continue
        raw = item.get("raw") if isinstance(item.get("raw"), dict) else {}
        if raw.get("status") != "rejected" and item.get("tool") != "workshop_contract_reject":
            continue
        violations.append(
            {
                "skill": str(item.get("skill") or raw.get("skill") or ""),
                "reason": str(raw.get("error") or ""),
            }
        )
    return violations


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
