"""Hermes-agent MCP 配置读取、工具目录与连通性探测。"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Any

import httpx
import yaml

logger = logging.getLogger("tpdx.hermes.mcp_registry")

# tphermes MCP 工具目录（与 backend/mcp_server.py 对齐）
TPHERMES_TOOL_CATALOG: list[dict[str, str]] = [
    {"name": "kb_query", "group": "knowledge", "title": "知识库检索", "description": "按语义检索 ChromaDB 集合"},
    {"name": "kb_list_collections", "group": "knowledge", "title": "列出知识集合", "description": "列出可用知识库 collection"},
    {"name": "kb_get_entry", "group": "knowledge", "title": "读取知识条目", "description": "按 ID 获取单条知识"},
    {"name": "kb_add_entry", "group": "knowledge", "title": "写入知识条目", "description": "用户确认后写入收割内容"},
    {"name": "workshop_list_skills", "group": "workshop", "title": "列出技能", "description": "列出工坊可用 Skill"},
    {"name": "workshop_get_skill_info", "group": "workshop", "title": "技能详情", "description": "获取 Skill 元数据"},
    {"name": "workshop_generate", "group": "workshop", "title": "执行技能", "description": "调用 Skill.generate 生成结果"},
    {"name": "workshop_generate_from_kb", "group": "workshop", "title": "知识增强生成", "description": "先检索 KB 再执行 Skill"},
    {"name": "project_list", "group": "project", "title": "项目列表", "description": "列出项目"},
    {"name": "project_create", "group": "project", "title": "创建项目", "description": "新建项目"},
    {"name": "project_get", "group": "project", "title": "项目详情", "description": "按 ID 获取项目"},
    {"name": "tavily_search", "group": "web", "title": "Tavily 搜索", "description": "联网搜索（经 tphermes 代理 Tavily MCP）"},
    {"name": "tavily_extract", "group": "web", "title": "Tavily 抽取", "description": "网页内容抽取（经 tphermes 代理）"},
    {"name": "list_resources", "group": "web", "title": "列出资源", "description": "MCP 资源列表（Tavily 代理）"},
    {"name": "read_resource", "group": "web", "title": "读取资源", "description": "MCP 资源读取（Tavily 代理）"},
    {"name": "list_prompts", "group": "web", "title": "列出 Prompt", "description": "MCP Prompt 列表（Tavily 代理）"},
    {"name": "get_prompt", "group": "web", "title": "获取 Prompt", "description": "MCP Prompt 读取（Tavily 代理）"},
]

TOOL_GROUP_LABELS: dict[str, str] = {
    "knowledge": "知识库",
    "workshop": "结果工坊",
    "project": "项目",
    "web": "联网 / Tavily",
}

DEFAULT_CONFIG_REL = Path("deploy/hermes-agent/config.yaml")


def _project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def get_config_path() -> Path:
    raw = os.getenv("HERMES_AGENT_CONFIG_PATH", "").strip()
    if raw:
        return Path(raw).expanduser()
    return _project_root() / DEFAULT_CONFIG_REL


def _resolve_server_url(server_cfg: dict[str, Any]) -> str:
    url = str(server_cfg.get("url") or "").strip()
    if url:
        return url
    command = server_cfg.get("command")
    if command:
        args = server_cfg.get("args") or []
        return f"stdio: {' '.join([str(command), *[str(a) for a in args]])}".strip()
    return ""


def load_config() -> dict[str, Any]:
    path = get_config_path()
    if not path.is_file():
        logger.warning("Hermes MCP config not found: %s", path)
        return {}
    with path.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    if not isinstance(data, dict):
        raise ValueError(f"Invalid config format: {path}")
    return data


def save_config(data: dict[str, Any]) -> Path:
    path = get_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    backup = path.with_suffix(path.suffix + ".bak")
    if path.is_file():
        backup.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        yaml.safe_dump(
            data,
            f,
            allow_unicode=True,
            default_flow_style=False,
            sort_keys=False,
        )
    tmp.replace(path)
    logger.info("Hermes MCP config saved: %s (backup=%s)", path, backup if backup.is_file() else "none")
    return path


def _tool_names_for_server(name: str, server_cfg: dict[str, Any]) -> list[str]:
    if name == "tphermes":
        return [t["name"] for t in TPHERMES_TOOL_CATALOG]
    tools_cfg = server_cfg.get("tools") or {}
    include = tools_cfg.get("include")
    if isinstance(include, list) and include:
        return [str(x) for x in include]
    return []


def _enabled_tools(server_cfg: dict[str, Any], catalog: list[str]) -> list[str]:
    tools_cfg = server_cfg.get("tools") or {}
    include = tools_cfg.get("include")
    exclude = {str(x) for x in (tools_cfg.get("exclude") or [])}
    if isinstance(include, list) and include:
        selected = [str(x) for x in include if str(x) not in exclude]
        return selected
    return [t for t in catalog if t not in exclude]


def serialize_server(name: str, server_cfg: dict[str, Any]) -> dict[str, Any]:
    catalog = _tool_names_for_server(name, server_cfg)
    enabled_tools = _enabled_tools(server_cfg, catalog)
    tools_cfg = server_cfg.get("tools") or {}
    return {
        "name": name,
        "enabled": server_cfg.get("enabled", True) is not False,
        "transport": "url" if server_cfg.get("url") else ("stdio" if server_cfg.get("command") else "unknown"),
        "url": _resolve_server_url(server_cfg),
        "timeout": server_cfg.get("timeout"),
        "connect_timeout": server_cfg.get("connect_timeout"),
        "tools": {
            "catalog": catalog,
            "enabled": enabled_tools,
            "include": list(tools_cfg.get("include") or []) if isinstance(tools_cfg.get("include"), list) else None,
            "exclude": list(tools_cfg.get("exclude") or []) if isinstance(tools_cfg.get("exclude"), list) else [],
        },
        "raw": {
            k: v
            for k, v in server_cfg.items()
            if k not in {"tools"}
        },
    }


def list_servers() -> dict[str, Any]:
    config = load_config()
    servers_cfg = config.get("mcp_servers") or {}
    if not isinstance(servers_cfg, dict):
        servers_cfg = {}
    servers = [
        serialize_server(str(name), cfg if isinstance(cfg, dict) else {})
        for name, cfg in servers_cfg.items()
    ]
    return {
        "config_path": str(get_config_path()),
        "config_exists": get_config_path().is_file(),
        "writable": os.access(get_config_path().parent, os.W_OK) if get_config_path().parent.exists() else True,
        "servers": servers,
        "tool_catalog": TPHERMES_TOOL_CATALOG,
        "tool_groups": TOOL_GROUP_LABELS,
        "tavily_mounted": bool(os.getenv("TAVILY_API_KEY", "").strip()),
    }


def update_server(name: str, *, enabled: bool | None = None, tools_include: list[str] | None = None) -> dict[str, Any]:
    config = load_config()
    servers_cfg = config.setdefault("mcp_servers", {})
    if not isinstance(servers_cfg, dict):
        raise ValueError("mcp_servers must be a mapping")
    if name not in servers_cfg or not isinstance(servers_cfg[name], dict):
        raise KeyError(name)
    server_cfg: dict[str, Any] = servers_cfg[name]
    if enabled is not None:
        server_cfg["enabled"] = enabled
    if tools_include is not None:
        tools_cfg = server_cfg.setdefault("tools", {})
        if not isinstance(tools_cfg, dict):
            tools_cfg = {}
            server_cfg["tools"] = tools_cfg
        tools_cfg["include"] = list(tools_include)
    save_config(config)
    return serialize_server(name, server_cfg)


async def probe_server(url: str) -> dict[str, Any]:
    target = (url or "").strip()
    if not target or target.startswith("stdio:"):
        return {"ok": False, "reachable": False, "message": "stdio 传输不支持 HTTP 探测"}
    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5.0, connect=3.0)) as client:
            resp = await client.get(target)
            latency_ms = int((time.perf_counter() - started) * 1000)
            ok = resp.status_code < 500
            return {
                "ok": ok,
                "reachable": True,
                "status_code": resp.status_code,
                "latency_ms": latency_ms,
                "message": "可达" if ok else f"HTTP {resp.status_code}",
            }
    except httpx.TimeoutException:
        return {"ok": False, "reachable": False, "latency_ms": int((time.perf_counter() - started) * 1000), "message": "连接超时"}
    except Exception as exc:
        logger.info("MCP probe failed url=%s err=%s", target, exc)
        return {"ok": False, "reachable": False, "message": str(exc)}
