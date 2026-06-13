"""对话首字延迟优化：轻量意图与 KB 预检索注入。"""
from __future__ import annotations

from backend.services.agent_gateway import is_lightweight_chat_message
from backend.services.kb_source_capture import format_kb_prefetch_prompt_block


def test_is_lightweight_chat_message_greetings():
    assert is_lightweight_chat_message("你好")
    assert is_lightweight_chat_message("Hello!")
    assert is_lightweight_chat_message("谢谢")
    assert is_lightweight_chat_message("一句话回复")


def test_is_lightweight_chat_message_substantive():
    assert not is_lightweight_chat_message("吉利星愿这款车有什么技术亮点？")
    assert not is_lightweight_chat_message("请帮我写一份关于智能座舱的技术一页纸，不少于500字")


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
