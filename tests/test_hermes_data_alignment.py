"""Hermes 数据传递对齐：task_input 合并、Ask/Plan 指引、token 自适应。"""

from __future__ import annotations

from backend.schemas.orchestration import (
    OrchestrationActor,
    OrchestrationExecution,
    OrchestrationPayload,
    OrchestrationProject,
    OrchestrationScenario,
    OrchestrationUserInput,
    TaskExecuteRequest,
    TaskInputPayload,
)
from backend.services.agent_gateway import _build_orchestration_guidance, build_chat_completion_body
from backend.services.orchestration_service import _merge_task_into_workshop_message
from backend.routes.tasks import _apply_chat_generation_limits


def test_chat_task_input_preserves_user_message():
    req = TaskExecuteRequest(
        entrypoint="chat",
        user_message="请根据附件写一段总结",
        task_input=TaskInputPayload(extra="【项目文件】/附件/a.md"),
    )
    merged = _merge_task_into_workshop_message(req)
    assert "请根据附件写一段总结" in merged
    assert "【项目文件】/附件/a.md" in merged


def test_chat_assemble_uses_merge_like_workshop():
    """assemble 侧 chat 与 workshop 共用 _merge_task_into_workshop_message。"""
    req = TaskExecuteRequest(
        entrypoint="chat",
        user_message="用户原话XYZ",
        task_input=TaskInputPayload(title="标题A", extra="引用块"),
    )
    text = _merge_task_into_workshop_message(req)
    assert "用户原话XYZ" in text
    assert "标题A" in text or "任务标题" in text
    assert "引用块" in text


def _sample_payload(**kwargs) -> OrchestrationPayload:
    base = dict(
        request_id="req_test",
        entrypoint="chat",
        project=OrchestrationProject(id="p1", name="demo"),
        scenario=OrchestrationScenario(id="general", name="通用"),
        user_input=OrchestrationUserInput(message="hi"),
        actor=OrchestrationActor(user_id="u1", role="tenant_editor"),
        execution=OrchestrationExecution(run_id="run1", session_id="sess1"),
    )
    base.update(kwargs)
    return OrchestrationPayload(**base)


def test_ask_mode_forbids_write_file_in_guidance():
    payload = _sample_payload(co_create_agent_mode="ask")
    text = _build_orchestration_guidance(payload)
    assert "Ask" in text or "只读" in text
    assert "禁止调用 write_file" in text or "禁止调用 write_file、patch" in text


def test_plan_mode_guidance_present():
    payload = _sample_payload(co_create_agent_mode="plan")
    text = _build_orchestration_guidance(payload)
    assert "Plan" in text
    assert "tphermes_plan" in text


def test_session_id_in_guidance_and_body():
    payload = _sample_payload()
    guidance = _build_orchestration_guidance(payload)
    assert "session_id=sess1" in guidance
    body = build_chat_completion_body(payload, [{"role": "user", "content": "hi"}])
    system = body["messages"][0]["content"]
    assert "sess1" in system
    assert "run1" in system or "run_id" in system


def test_token_limits_long_for_project_chat(monkeypatch):
    monkeypatch.delenv("CHAT_MAX_TOKENS", raising=False)
    monkeypatch.delenv("CHAT_MAX_TOKENS_LONG", raising=False)
    payload = _sample_payload()
    body: dict = {"model": "hermes-agent", "messages": []}
    _apply_chat_generation_limits(body, payload=payload, lightweight_mode=False)
    assert body["max_tokens"] == 4096


def test_token_limits_light(monkeypatch):
    monkeypatch.delenv("CHAT_MAX_TOKENS", raising=False)
    payload = _sample_payload()
    body: dict = {"model": "hermes-agent", "messages": []}
    _apply_chat_generation_limits(body, payload=payload, lightweight_mode=True)
    assert body["max_tokens"] == 512
