"""GeelyWiki MCP 接入配置。

页面已写出的 url 以本文件为准。键缺失或值为 null 时才回落 GEELYWIKI_MCP_URL，
空字符串也算已写出，不再用环境变量盖回。
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger("tpdx.hermes.geelywiki_mcp_config")

DEFAULT_MCP_URL = "http://127.0.0.1:8787/mcp"


def config_path() -> Path:
    override = (os.getenv("TPDHERMES_GEELYWIKI_MCP_CONFIG") or "").strip()
    if override:
        return Path(override).expanduser()
    return Path.home() / "Library/Application Support/tphermes/geelywiki-mcp.json"


def _read_file() -> dict[str, Any] | None:
    path = config_path()
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("geelywiki mcp config unreadable path=%s err=%s", path, exc)
        return None
    if not isinstance(raw, dict):
        return None
    return raw


def load_written() -> dict[str, str]:
    raw = _read_file()
    if raw is None or "url" not in raw or raw["url"] is None:
        return {}
    return {"url": str(raw["url"]).strip()}


def resolve_wiki_mcp() -> dict[str, Any]:
    written = load_written()
    if "url" in written:
        url, source = written["url"], "saved"
    else:
        env = os.getenv("GEELYWIKI_MCP_URL")
        if env is not None and env.strip():
            url, source = env.strip(), "env"
        else:
            url, source = DEFAULT_MCP_URL, "default"
    path = config_path()
    parent = path.parent
    writable = os.access(parent, os.W_OK) if parent.exists() else True
    payload = {
        "config_path": str(path),
        "config_exists": path.is_file() and "url" in written,
        "writable": writable,
        "url": url,
        "url_source": source,
    }
    logger.info(
        "geelywiki mcp config resolved url_source=%s config_exists=%s",
        source,
        payload["config_exists"],
    )
    return payload


def save_wiki_mcp(*, url: str) -> dict[str, Any]:
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    document = {"url": url.strip()}
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)
    logger.info("geelywiki mcp config saved path=%s url_set=%s", path, bool(document["url"]))
    return resolve_wiki_mcp()


def probe_wiki_mcp(*, url: str) -> dict[str, Any]:
    """用当前表单地址调用 pages_list，不写配置。"""
    from backend.services.geelywiki_mcp import GeelyWikiMcpError, call_wiki_tool

    target = url.strip()
    if not target:
        logger.info("geelywiki mcp probe skipped reason=empty_url")
        return {"ok": False, "reachable": False, "message": "MCP 地址为空"}
    started = time.perf_counter()
    try:
        payload = call_wiki_tool(target, "pages_list", timeout=30)
    except GeelyWikiMcpError as exc:
        latency_ms = int((time.perf_counter() - started) * 1000)
        logger.info("geelywiki mcp probe failed latency_ms=%s err=%s", latency_ms, exc)
        return {"ok": False, "reachable": False, "latency_ms": latency_ms, "message": str(exc)}
    items = payload.get("items")
    count = len(items) if isinstance(items, list) else int(payload.get("count") or 0)
    latency_ms = int((time.perf_counter() - started) * 1000)
    logger.info("geelywiki mcp probe ok count=%s latency_ms=%s", count, latency_ms)
    return {
        "ok": True,
        "reachable": True,
        "count": count,
        "latency_ms": latency_ms,
        "message": f"连通，pages_list 返回 {count} 条",
    }
