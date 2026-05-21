"""KB collection 解析与 MCP context 容错。"""

import json

import pytest

from backend.mcp_tool_utils import coerce_tool_context
from backend.services.kb_collection_resolve import merge_kb_warnings, resolve_collection_name


@pytest.mark.asyncio
async def test_resolve_exact_match(monkeypatch):
    async def fake_list(project_id=None):
        return {"collections": ["public.structured_tech.geely_tech", "project.p1.kb"]}

    from backend.services import kb_collection_resolve as mod

    monkeypatch.setattr(mod.kb_proxy_service, "list_collections", fake_list)
    name, warn = await resolve_collection_name("public.structured_tech.geely_tech")
    assert name == "public.structured_tech.geely_tech"
    assert warn is None


@pytest.mark.asyncio
async def test_resolve_short_suffix(monkeypatch):
    async def fake_list(project_id=None):
        return {"collections": ["public.structured_tech.geely_tech"]}

    from backend.services import kb_collection_resolve as mod

    monkeypatch.setattr(mod.kb_proxy_service, "list_collections", fake_list)
    name, warn = await resolve_collection_name("geely_tech")
    assert name == "public.structured_tech.geely_tech"
    assert warn and "自动修正" in warn


@pytest.mark.asyncio
async def test_resolve_ambiguous_short_name(monkeypatch):
    async def fake_list(project_id=None):
        return {
            "collections": [
                "public.structured_tech.geely_tech",
                "internal.structured_tech.geely_tech",
            ]
        }

    from backend.services import kb_collection_resolve as mod

    monkeypatch.setattr(mod.kb_proxy_service, "list_collections", fake_list)
    name, warn = await resolve_collection_name("geely_tech")
    assert name == "geely_tech"
    assert warn and "多个集合" in warn


def test_merge_kb_warnings():
    assert merge_kb_warnings(None, "a", "b") == "a | b"
    assert merge_kb_warnings("x", None) == "x"


def test_coerce_tool_context_json_string():
    ctx = coerce_tool_context('{"tone":"正式","cta":"预约体验"}')
    assert ctx == {"tone": "正式", "cta": "预约体验"}


def test_coerce_tool_context_dict():
    assert coerce_tool_context({"a": 1}) == {"a": 1}


def test_coerce_tool_context_invalid_json():
    ctx = coerce_tool_context("not-json")
    assert ctx.get("_raw_context") == "not-json"
