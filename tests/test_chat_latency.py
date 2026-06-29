"""对话首字延迟优化：轻量意图与 KB 预检索注入。"""
from __future__ import annotations

from backend.services.agent_gateway import (
    is_lightweight_chat_message,
    should_skip_kb_prefetch_for_co_create_draft,
)
from backend.services.kb_source_capture import format_kb_prefetch_prompt_block


def test_is_lightweight_chat_message_greetings():
    assert is_lightweight_chat_message("你好")
    assert is_lightweight_chat_message("Hello!")
    assert is_lightweight_chat_message("谢谢")
    assert is_lightweight_chat_message("一句话回复")


def test_is_lightweight_chat_message_substantive():
    assert not is_lightweight_chat_message("吉利星愿这款车有什么技术亮点？")
    assert not is_lightweight_chat_message("请帮我写一份关于智能座舱的技术一页纸，不少于500字")


def test_should_skip_kb_prefetch_for_co_create_draft():
    assert should_skip_kb_prefetch_for_co_create_draft("撰写一篇吉利超充技术的发布会稿")
    assert should_skip_kb_prefetch_for_co_create_draft("请生成一份产品需求文档")
    assert should_skip_kb_prefetch_for_co_create_draft(
        "请基于当前项目上下文，输出一版可用于外部沟通的技术方案说明。"
    )
    assert not should_skip_kb_prefetch_for_co_create_draft("吉利星愿这款车有什么技术亮点？")
    assert not should_skip_kb_prefetch_for_co_create_draft("你好")


def test_chat_force_skill_mode_disabled_for_co_create():
    from backend.routes.tasks import _chat_force_skill_mode
    from backend.schemas.orchestration import (
        OrchestrationExecution,
        OrchestrationOutput,
        OrchestrationPayload,
        OrchestrationProject,
        OrchestrationScenario,
        OrchestrationSkills,
        OrchestrationUserInput,
    )

    payload = OrchestrationPayload(
        request_id="req_test",
        entrypoint="chat",
        project=OrchestrationProject(id="p1", name="test"),
        scenario=OrchestrationScenario(id="tech-doc", name="技术方案说明"),
        skills=OrchestrationSkills(
            mode="allowed_list",
            allowed=["tech_trend_skill"],
            allow_agent_free_choice=False,
        ),
        output=OrchestrationOutput(),
        execution=OrchestrationExecution(stream=True),
        user_input=OrchestrationUserInput(message="输出技术方案"),
    )
    assert _chat_force_skill_mode(payload) is True
    assert _chat_force_skill_mode(payload, chat_mode="co_create") is False


def test_format_kb_prefetch_prompt_block():
    capture = {
        "sources": [
            {
                "ref": 1,
                "title": "技术白皮书",
                "collection": "internal.structured_tech.tech_points",
                "excerpt": "GEA 架构说明",
            }
        ]
    }
    block = format_kb_prefetch_prompt_block(capture, "GEA 架构")
    assert "[系统预检索结果]" in block
    assert "[^1]" in block
    assert "勿对相同 query 重复调用 kb_query" in block
    assert "GEA 架构说明" in block


def test_format_kb_prefetch_prompt_block_empty():
    assert format_kb_prefetch_prompt_block(None, "q") == ""
    assert format_kb_prefetch_prompt_block({"sources": []}, "q") == ""
