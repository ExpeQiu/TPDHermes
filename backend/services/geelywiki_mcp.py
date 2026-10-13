"""经 GeelyWiki MCP 拉取页面更新。"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

import httpx

logger = logging.getLogger("tpdx.hermes.geelywiki_mcp")

PROTOCOL_VERSION = "2025-03-26"


class GeelyWikiMcpError(RuntimeError):
    pass


def _post(url: str, payload: dict[str, Any], *, timeout: float) -> dict[str, Any]:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    try:
        response = httpx.post(url, json=payload, headers=headers, timeout=timeout)
    except httpx.TimeoutException as exc:
        raise GeelyWikiMcpError(f"GeelyWiki MCP 超时: {payload.get('method')}") from exc
    except httpx.HTTPError as exc:
        raise GeelyWikiMcpError(f"GeelyWiki MCP 连接失败: {exc}") from exc
    if response.status_code >= 400:
        raise GeelyWikiMcpError(f"GeelyWiki MCP HTTP {response.status_code}")
    try:
        body = response.json()
    except json.JSONDecodeError as exc:
        raise GeelyWikiMcpError("GeelyWiki MCP 响应不是 JSON") from exc
    if not isinstance(body, dict):
        raise GeelyWikiMcpError("GeelyWiki MCP 响应必须是对象")
    if body.get("error"):
        err = body["error"]
        message = err.get("message") if isinstance(err, dict) else str(err)
        raise GeelyWikiMcpError(message or "GeelyWiki MCP 调用失败")
    result = body.get("result")
    if not isinstance(result, dict):
        raise GeelyWikiMcpError("GeelyWiki MCP 缺少 result")
    return result


def _rpc(url: str, method: str, params: dict[str, Any] | None, req_id: int, *, timeout: float) -> dict[str, Any]:
    payload: dict[str, Any] = {"jsonrpc": "2.0", "id": req_id, "method": method}
    if params is not None:
        payload["params"] = params
    return _post(url, payload, timeout=timeout)


def _tool_payload(result: dict[str, Any]) -> dict[str, Any]:
    if result.get("isError"):
        raise GeelyWikiMcpError("GeelyWiki MCP 工具返回错误")
    content = result.get("content")
    if not isinstance(content, list) or not content:
        raise GeelyWikiMcpError("GeelyWiki MCP 工具没有内容")
    first = content[0] if isinstance(content[0], dict) else {}
    text = str(first.get("text") or "").strip()
    if not text:
        raise GeelyWikiMcpError("GeelyWiki MCP 工具内容为空")
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise GeelyWikiMcpError("GeelyWiki MCP 工具内容不是 JSON") from exc
    if not isinstance(parsed, dict):
        raise GeelyWikiMcpError("GeelyWiki MCP 工具 JSON 必须是对象")
    return parsed


def call_wiki_tool(url: str, name: str, arguments: dict[str, Any] | None = None, *, timeout: float = 30) -> dict[str, Any]:
    target = url.strip()
    if not target:
        raise GeelyWikiMcpError("MCP 地址为空")
    started = time.perf_counter()
    _rpc(
        target,
        "initialize",
        {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "tpdhermes", "version": "0.1.0"},
        },
        1,
        timeout=timeout,
    )
    result = _rpc(
        target,
        "tools/call",
        {"name": name, "arguments": arguments or {}},
        2,
        timeout=timeout,
    )
    payload = _tool_payload(result)
    logger.info(
        "geelywiki mcp tool=%s url=%s ms=%s",
        name,
        target,
        int((time.perf_counter() - started) * 1000),
    )
    return payload


def fetch_pages_via_mcp(*, demo: bool = False, url: str | None = None) -> dict[str, Any]:
    """优先 pages_export；失败则 pages_list + pages_get。"""
    from backend.services.geelywiki_cli_config import resolve_wiki_mcp

    target = (url if url is not None else str(resolve_wiki_mcp()["url"] or "")).strip()
    args = {"demo": True} if demo else {}
    try:
        exported = call_wiki_tool(target, "pages_export", args, timeout=90)
    except GeelyWikiMcpError as exc:
        logger.warning("pages_export 不可用，回退 list+get: %s", exc)
        exported = {}
    if exported.get("module") == "pages-export":
        pages = [page for page in (exported.get("pages") or []) if isinstance(page, dict)]
        logger.info("geelywiki mcp export count=%s source=%s", len(pages), exported.get("data_source"))
        return {
            "publish_scope": exported.get("publish_scope") or "internal",
            "data_source": exported.get("data_source") or ("demo" if demo else "mcp"),
            "fetched_at": exported.get("fetched_at"),
            "pages": pages,
        }

    listed = call_wiki_tool(target, "pages_list", args, timeout=30)
    pages: list[dict[str, Any]] = []
    for row in listed.get("items") or []:
        if not isinstance(row, dict):
            continue
        slug = str(row.get("slug") or "").strip()
        if not slug:
            continue
        got = call_wiki_tool(target, "pages_get", {"slug": slug, **args}, timeout=30)
        item = got.get("item") if isinstance(got.get("item"), dict) else None
        if item and str(item.get("body") or "").strip():
            pages.append(item)
        else:
            logger.warning("geelywiki mcp pages_get 缺正文 slug=%s", slug)
    logger.info("geelywiki mcp list+get count=%s", len(pages))
    return {
        "publish_scope": "internal",
        "data_source": listed.get("data_source") or ("demo" if demo else "mcp"),
        "fetched_at": listed.get("fetched_at"),
        "pages": pages,
    }
