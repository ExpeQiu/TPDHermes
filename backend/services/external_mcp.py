"""三方 MCP 预留。站点地址来自目录，MCP 端点一旦保存就不再被环境变量盖回。"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger("tpdx.hermes.external_mcp")

PROTOCOL_VERSION = "2025-03-26"

# 公开站点不是 MCP 端点。mcp_url 留空表示只预留，接入时再填写。
PROVIDERS: tuple[dict[str, str], ...] = (
    {
        "id": "autocar",
        "name": "Autocar Wiki",
        "site": "https://autocar.aiforworld.cn/",
        "summary": "新能源汽车技术 Wiki。MCP 端点预留，填写后再探测，不写入 Hermes mcp_servers。",
        "env": "AUTOCAR_MCP_URL",
    },
)


def config_path() -> Path:
    override = (os.getenv("TPDHERMES_EXTERNAL_MCP_CONFIG") or "").strip()
    if override:
        return Path(override).expanduser()
    return Path.home() / "Library/Application Support/tphermes/external-mcp.json"


def _read_file() -> dict[str, Any] | None:
    path = config_path()
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("external mcp config unreadable path=%s err=%s", path, exc)
        return None
    if not isinstance(raw, dict):
        return None
    return raw


def _written_urls(raw: dict[str, Any] | None) -> dict[str, str]:
    if not raw:
        return {}
    providers = raw.get("providers")
    if not isinstance(providers, dict):
        return {}
    written: dict[str, str] = {}
    for item in PROVIDERS:
        row = providers.get(item["id"])
        if not isinstance(row, dict) or "mcp_url" not in row or row["mcp_url"] is None:
            continue
        written[item["id"]] = str(row["mcp_url"]).strip()
    return written


def resolve_external_mcp() -> dict[str, Any]:
    written = _written_urls(_read_file())
    providers = []
    for item in PROVIDERS:
        provider_id = item["id"]
        if provider_id in written:
            mcp_url, source = written[provider_id], "saved"
        else:
            env = os.getenv(item["env"])
            if env is not None and env.strip():
                mcp_url, source = env.strip(), "env"
            else:
                mcp_url, source = "", "default"
        providers.append(
            {
                "id": provider_id,
                "name": item["name"],
                "site": item["site"],
                "summary": item["summary"],
                "status": "configured" if mcp_url else "reserved",
                "mcp_url": mcp_url,
                "mcp_url_source": source,
            }
        )
    path = config_path()
    parent = path.parent
    payload = {
        "config_path": str(path),
        "config_exists": path.is_file(),
        "writable": os.access(parent, os.W_OK) if parent.exists() else True,
        "providers": providers,
    }
    logger.info(
        "external mcp resolved providers=%s",
        ",".join(f"{row['id']}:{row['status']}" for row in providers),
    )
    return payload


def save_external_mcp(provider_id: str, *, mcp_url: str) -> dict[str, Any]:
    known = {item["id"] for item in PROVIDERS}
    if provider_id not in known:
        raise KeyError(provider_id)
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = _read_file() or {}
    providers = raw.get("providers") if isinstance(raw.get("providers"), dict) else {}
    current = providers.get(provider_id) if isinstance(providers.get(provider_id), dict) else {}
    current["mcp_url"] = mcp_url.strip()
    providers[provider_id] = current
    document = {"providers": providers}
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)
    logger.info(
        "external mcp saved provider=%s url_set=%s path=%s",
        provider_id,
        bool(current["mcp_url"]),
        path,
    )
    return resolve_external_mcp()


def _rpc(url: str, method: str, params: dict[str, Any] | None, req_id: int) -> dict[str, Any]:
    payload: dict[str, Any] = {"jsonrpc": "2.0", "id": req_id, "method": method}
    if params is not None:
        payload["params"] = params
    try:
        response = httpx.post(
            url,
            json=payload,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
            },
            timeout=15,
        )
    except httpx.TimeoutException as exc:
        raise RuntimeError(f"MCP 超时: {method}") from exc
    except httpx.HTTPError as exc:
        raise RuntimeError(f"MCP 连接失败: {exc}") from exc
    if response.status_code >= 400:
        raise RuntimeError(f"MCP HTTP {response.status_code}")
    try:
        body = response.json()
    except json.JSONDecodeError as exc:
        raise RuntimeError("MCP 响应不是 JSON") from exc
    if not isinstance(body, dict):
        raise RuntimeError("MCP 响应必须是对象")
    if body.get("error"):
        err = body["error"]
        message = err.get("message") if isinstance(err, dict) else str(err)
        raise RuntimeError(message or "MCP 调用失败")
    result = body.get("result")
    if not isinstance(result, dict):
        raise RuntimeError("MCP 缺少 result")
    return result


def probe_external_mcp(provider_id: str, *, mcp_url: str) -> dict[str, Any]:
    known = {item["id"] for item in PROVIDERS}
    if provider_id not in known:
        raise KeyError(provider_id)
    target = mcp_url.strip()
    if not target:
        logger.info("external mcp probe skipped provider=%s reason=reserved", provider_id)
        return {
            "ok": False,
            "reserved": True,
            "reachable": False,
            "message": "尚未填写 MCP 地址，当前为预留",
        }
    started = time.perf_counter()
    try:
        _rpc(
            target,
            "initialize",
            {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "tpdhermes", "version": "0.1.0"},
            },
            1,
        )
        listed = _rpc(target, "tools/list", {}, 2)
    except RuntimeError as exc:
        latency_ms = int((time.perf_counter() - started) * 1000)
        logger.info("external mcp probe failed provider=%s latency_ms=%s err=%s", provider_id, latency_ms, exc)
        return {"ok": False, "reserved": False, "reachable": False, "latency_ms": latency_ms, "message": str(exc)}
    tools = listed.get("tools")
    count = len(tools) if isinstance(tools, list) else 0
    latency_ms = int((time.perf_counter() - started) * 1000)
    logger.info("external mcp probe ok provider=%s tools=%s latency_ms=%s", provider_id, count, latency_ms)
    return {
        "ok": True,
        "reserved": False,
        "reachable": True,
        "count": count,
        "latency_ms": latency_ms,
        "message": f"连通，tools/list 返回 {count} 个工具",
    }
