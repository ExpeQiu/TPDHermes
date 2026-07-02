"""共创 Ask 模式：公共库编排与 Agent 指引。"""

from backend.schemas.orchestration import (
    OrchestrationExecution,
    OrchestrationPayload,
    OrchestrationProject,
    OrchestrationScenario,
    OrchestrationUserInput,
)
from backend.services.agent_gateway import _build_orchestration_guidance
from backend.services.kb_contract import KB_AUTHORITATIVE_COLLECTIONS
from backend.services.project_kb import merge_co_create_ask_kb_collections, project_kb_collection


def _ask_payload(collections: list[str]) -> OrchestrationPayload:
    return OrchestrationPayload(
        request_id="req_test",
        entrypoint="chat",
        project=OrchestrationProject(id="proj-1", name="测试项目"),
        scenario=OrchestrationScenario(id="general", name="通用对话", goal=""),
        knowledge={"collections": collections, "project_bound": False},
        execution=OrchestrationExecution(run_id="run-1"),
        user_input=OrchestrationUserInput(message="雷神 EM-i 技术点"),
        co_create_agent_mode="ask",
    )


def test_ask_orchestration_guidance_requires_public_and_web():
    pid = "proj-1"
    cols = merge_co_create_ask_kb_collections([], pid)
    guidance = _build_orchestration_guidance(_ask_payload(cols))
    assert "Ask 检索强制策略" in guidance
    assert "tavily_search" in guidance
    for col in KB_AUTHORITATIVE_COLLECTIONS:
        assert col in guidance or "真源" in guidance


def test_non_ask_payload_omits_forced_ask_block():
    payload = _ask_payload([project_kb_collection("proj-1")])
    payload = payload.model_copy(update={"co_create_agent_mode": "agent"})
    guidance = _build_orchestration_guidance(payload)
    assert "Ask 检索强制策略" not in guidance
