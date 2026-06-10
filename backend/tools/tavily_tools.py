"""Tavily 联网检索 MCP 工具（带来源捕获）。"""
from __future__ import annotations

import hashlib
import logging
import os
from typing import Any

import httpx

logger = logging.getLogger("tpdx.hermes")

WEB_SOURCE_LABEL = "互联网"


def _tavily_api_key() -> str:
    return os.getenv("TAVILY_API_KEY", "").strip()


def _tavily_request(endpoint: str, payload: dict[str, Any]) -> dict[str, Any]:
    api_key = _tavily_api_key()
    if not api_key:
        raise ValueError(
            "TAVILY_API_KEY 未配置，无法使用联网检索。"
            "请在环境变量中设置 TAVILY_API_KEY。"
        )
    base_url = os.getenv("TAVILY_BASE_URL", "https://api.tavily.com").rstrip("/")
    body = dict(payload)
    body["api_key"] = api_key
    url = f"{base_url}/{endpoint.lstrip('/')}"
    with httpx.Client(timeout=60.0) as client:
        resp = client.post(url, json=body)
        resp.raise_for_status()
        data = resp.json()
    return data if isinstance(data, dict) else {}


def _web_chunk_id(url: str) -> str:
    u = (url or "").strip()
    if not u:
        return ""
    if len(u) <= 240:
        return f"web:{u}"
    digest = hashlib.sha256(u.encode()).hexdigest()[:16]
    return f"web:{digest}"


async def _finalize_web_tool_result(
    result: dict[str, Any],
    *,
    tool_name: str,
    tphermes_run_id: str | None,
    project_id: str | None,
) -> dict[str, Any]:
    from backend.services.kb_source_capture import (
        annotate_web_results_with_capture,
        save_web_sources_for_run,
    )

    if not tphermes_run_id and not project_id:
        return result
    capture = await save_web_sources_for_run(
        run_id=tphermes_run_id,
        project_id=project_id,
        tool_name=tool_name,
        payload=result,
    )
    rows = list(result.get("results") or [])
    if rows:
        out = dict(result)
        out["results"] = annotate_web_results_with_capture(rows, capture)
        return out
    return result


async def tavily_search(
    query: str,
    max_results: int = 5,
    tphermes_run_id: str | None = None,
    project_id: str | None = None,
) -> dict[str, Any]:
    """
    联网搜索（Tavily）。返回 results 列表，每项含 ref 供 [^N] 引用。
    """
    q = (query or "").strip()
    if not q:
        return {"results": [], "count": 0, "query": query, "source": "tavily"}

    limit = max(1, min(int(max_results or 5), 20))
    try:
        raw = _tavily_request(
            "search",
            {
                "query": q,
                "max_results": limit,
                "include_raw_content": False,
                "include_images": False,
            },
        )
    except Exception as exc:
        logger.warning("tavily_search failed query=%r err=%s", q[:80], exc)
        return {"results": [], "count": 0, "query": q, "error": str(exc), "source": "tavily"}

    rows = raw.get("results") if isinstance(raw.get("results"), list) else []
    result = {
        "results": rows,
        "count": len(rows),
        "query": q,
        "source": "tavily",
        "source_kind": "web",
    }
    return await _finalize_web_tool_result(
        result,
        tool_name="tavily_search",
        tphermes_run_id=tphermes_run_id,
        project_id=project_id,
    )


async def tavily_extract(
    urls: list[str] | str,
    tphermes_run_id: str | None = None,
    project_id: str | None = None,
) -> dict[str, Any]:
    """抽取网页正文（Tavily）。"""
    if isinstance(urls, str):
        url_list = [u.strip() for u in urls.split(",") if u.strip()]
    else:
        url_list = [str(u).strip() for u in (urls or []) if str(u).strip()]
    if not url_list:
        return {"results": [], "count": 0, "source": "tavily", "source_kind": "web"}

    try:
        raw = _tavily_request(
            "extract",
            {"urls": url_list[:20], "include_images": False},
        )
    except Exception as exc:
        logger.warning("tavily_extract failed urls=%s err=%s", len(url_list), exc)
        return {"results": [], "count": 0, "error": str(exc), "source": "tavily"}

    docs: list[dict[str, Any]] = []
    for row in raw.get("results") or []:
        if not isinstance(row, dict):
            continue
        url = str(row.get("url") or "")
        content = str(row.get("raw_content") or row.get("content") or "")
        docs.append(
            {
                "url": url,
                "title": row.get("title") or url,
                "content": content,
            }
        )
    result = {
        "results": docs,
        "count": len(docs),
        "source": "tavily",
        "source_kind": "web",
    }
    return await _finalize_web_tool_result(
        result,
        tool_name="tavily_extract",
        tphermes_run_id=tphermes_run_id,
        project_id=project_id,
    )
