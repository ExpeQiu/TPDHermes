"""七个工作台的 CLI 能力目录与可保存配置。

已写入的 enabled / demo / defaults 以文件为准。只有字段为 null 时才回落环境变量。
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

logger = logging.getLogger("tpdhermes.cli")

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_NO_DATA = 2
EXIT_UPSTREAM = 3

MODULES: list[dict[str, Any]] = [
    {
        "id": "project",
        "label": "项目中心",
        "command": "project",
        "default_key": "project",
        "actions": {
            "list": {"label": "项目列表", "method": "GET", "path": "/api/v1/projects/"},
            "show": {"label": "项目详情", "method": "GET", "path": "/api/v1/projects/{id}", "requires": ["id"]},
            "members": {
                "label": "项目成员",
                "method": "GET",
                "path": "/api/v1/projects/{project}/members",
                "requires": ["project"],
            },
            "attachments": {
                "label": "项目文件",
                "method": "GET",
                "path": "/api/v1/projects/{project}/attachments",
                "requires": ["project"],
            },
            "outputs": {
                "label": "输出沉淀",
                "method": "GET",
                "path": "/api/v1/projects/{project}/outputs",
                "requires": ["project"],
            },
            "runs": {
                "label": "执行记录",
                "method": "GET",
                "path": "/api/v1/projects/{project}/runs",
                "requires": ["project"],
            },
            "scenarios": {
                "label": "场景绑定",
                "method": "GET",
                "path": "/api/v1/projects/{project}/scenarios",
                "requires": ["project"],
            },
        },
    },
    {
        "id": "cocreate",
        "label": "项目共创",
        "command": "cocreate",
        "default_key": "project",
        "actions": {
            "context": {
                "label": "共创上下文",
                "method": "GET",
                "path": "/api/v1/projects/{project}/context",
                "requires": ["project"],
            },
            "files": {
                "label": "引用文件",
                "method": "GET",
                "path": "/api/v1/projects/{project}/files",
                "requires": ["project"],
            },
            "file": {
                "label": "文件详情",
                "method": "GET",
                "path": "/api/v1/projects/{project}/files/{file}",
                "requires": ["project", "file"],
            },
            "outputs": {
                "label": "产出列表",
                "method": "GET",
                "path": "/api/v1/projects/{project}/outputs",
                "requires": ["project"],
            },
            "output": {
                "label": "产出详情",
                "method": "GET",
                "path": "/api/v1/projects/{project}/outputs/{output}",
                "requires": ["project", "output"],
            },
            "ask": {
                "label": "发起共创",
                "method": "POST",
                "path": "/api/v1/tasks/execute",
                "requires": ["project", "text"],
                "body": "task",
                "entrypoint": "chat",
                "chat_mode": "co_create",
            },
        },
    },
    {
        "id": "chat",
        "label": "对话创作",
        "command": "chat",
        "default_key": None,
        "actions": {
            "sessions": {"label": "会话列表", "method": "GET", "path": "/api/v1/chat/sessions"},
            "show": {
                "label": "会话详情",
                "method": "GET",
                "path": "/api/v1/chat/sessions/{id}",
                "requires": ["id"],
            },
            "upstream": {"label": "上游配置", "method": "GET", "path": "/api/v1/chat/config"},
            "ask": {
                "label": "发送消息",
                "method": "POST",
                "path": "/api/v1/tasks/execute",
                "requires": ["text"],
                "body": "task",
                "entrypoint": "chat",
            },
        },
    },
    {
        "id": "workshop",
        "label": "场景输出",
        "command": "workshop",
        "default_key": "skill",
        "actions": {
            "skills": {"label": "可执行技能", "method": "GET", "path": "/api/v1/ws/skills"},
            "templates": {"label": "输出模版", "method": "GET", "path": "/api/v1/ws/skills/metadata"},
            "run": {
                "label": "生成输出",
                "method": "POST",
                "path": "/api/v1/tasks/execute",
                "requires": ["text", "skill"],
                "body": "task",
                "entrypoint": "workshop",
            },
        },
    },
    {
        "id": "scene",
        "label": "场景编排",
        "command": "scene",
        "default_key": None,
        "actions": {
            "list": {"label": "场景列表", "method": "GET", "path": "/api/v1/scenarios/"},
            "show": {"label": "场景详情", "method": "GET", "path": "/api/v1/scenarios/{id}", "requires": ["id"]},
            "contract": {
                "label": "场景合同",
                "method": "GET",
                "path": "/api/v1/scenarios/{id}/contract",
                "requires": ["id"],
            },
            "preview": {
                "label": "编排预览",
                "method": "POST",
                "path": "/api/v1/scenarios/{id}/preview",
                "requires": ["id"],
                "body": "preview",
            },
            "publish": {
                "label": "发布场景",
                "method": "POST",
                "path": "/api/v1/scenarios/{id}/publish",
                "requires": ["id"],
            },
            "disable": {
                "label": "停用场景",
                "method": "POST",
                "path": "/api/v1/scenarios/{id}/disable",
                "requires": ["id"],
            },
        },
    },
    {
        "id": "kb",
        "label": "知识库",
        "command": "kb",
        "default_key": "collection",
        "actions": {
            "health": {"label": "健康检查", "method": "GET", "path": "/api/v1/kb/health"},
            "collections": {"label": "集合列表", "method": "GET", "path": "/api/v1/kb/collections"},
            "browse": {
                "label": "目录树",
                "method": "GET",
                "path": "/api/v1/kb/browse-tree",
                "query": {"project_id": "project", "collection": "collection"},
            },
            "query": {
                "label": "集合检索",
                "method": "POST",
                "path": "/api/v1/kb/query",
                "requires": ["text"],
                "body": "kb_query",
            },
            "query-all": {
                "label": "全库检索",
                "method": "GET",
                "path": "/api/v1/kb/query-all",
                "requires": ["text"],
                "query": {"q": "text", "n": "n", "collection": "collection", "project_id": "project"},
            },
            "policies": {"label": "知识策略", "method": "GET", "path": "/api/v1/kb/policies/"},
        },
    },
    {
        "id": "skill",
        "label": "技能工坊",
        "command": "skill",
        "default_key": "skill",
        "actions": {
            "list": {"label": "已安装技能", "method": "GET", "path": "/api/v1/skills/"},
            "show": {"label": "技能详情", "method": "GET", "path": "/api/v1/skills/{name}", "requires": ["name"]},
            "market": {"label": "技能市场", "method": "GET", "path": "/api/v1/skills/marketplace"},
            "enable": {
                "label": "启用或停用",
                "method": "PATCH",
                "path": "/api/v1/skills/{name}/enable",
                "requires": ["name", "enabled"],
                "body": "skill_enable",
            },
            "versions": {
                "label": "版本记录",
                "method": "GET",
                "path": "/api/v1/skills/{name}/versions",
                "requires": ["name"],
            },
        },
    },
]

_BY_ID = {item["id"]: item for item in MODULES}


def config_path() -> Path:
    override = (os.getenv("TPDHERMES_CLI_CONFIG") or "").strip()
    if override:
        return Path(override).expanduser()
    return Path.home() / "Library/Application Support/tphermes/cli-modules.json"


def default_document() -> dict[str, Any]:
    modules: dict[str, Any] = {}
    for item in MODULES:
        modules[item["id"]] = {"enabled": True, "demo": None, "defaults": {}}
    return {"api_base": None, "user_id": None, "token": None, "modules": modules}


def _read_file() -> dict[str, Any] | None:
    path = config_path()
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("cli config unreadable path=%s err=%s", path, exc)
        return None
    if not isinstance(raw, dict):
        return None
    return raw


def _module_row(saved: dict[str, Any] | None) -> dict[str, Any]:
    row: dict[str, Any] = {"enabled": True, "demo": None, "defaults": {}, "actions": {}}
    if not isinstance(saved, dict):
        return row
    if "enabled" in saved:
        row["enabled"] = bool(saved["enabled"])
    if "demo" in saved:
        row["demo"] = saved["demo"] if isinstance(saved["demo"], bool) else None
    defaults = saved.get("defaults")
    if isinstance(defaults, dict):
        row["defaults"] = {str(k): str(v) for k, v in defaults.items() if v is not None}
    actions = saved.get("actions")
    if isinstance(actions, dict):
        row["actions"] = {str(k): bool(v) for k, v in actions.items() if isinstance(v, bool)}
    return row


def load_document() -> tuple[dict[str, Any], str]:
    """返回归一化文档与 data_source。缺文件时用默认，不把环境变量写进 enabled。"""
    saved = _read_file()
    base = default_document()
    if saved is None:
        return base, "default"
    if "api_base" in saved:
        base["api_base"] = saved["api_base"] if isinstance(saved["api_base"], str) else None
    if "user_id" in saved:
        base["user_id"] = saved["user_id"] if isinstance(saved["user_id"], str) else None
    if "token" in saved:
        raw_token = saved["token"]
        base["token"] = raw_token.strip() if isinstance(raw_token, str) and raw_token.strip() else None
    incoming = saved.get("modules") if isinstance(saved.get("modules"), dict) else {}
    for item in MODULES:
        if item["id"] in incoming:
            base["modules"][item["id"]] = _module_row(incoming[item["id"]])
    return base, "saved"


def save_document(patch: dict[str, Any]) -> dict[str, Any]:
    current, _source = load_document()
    if "api_base" in patch:
        value = patch["api_base"]
        current["api_base"] = value.strip() if isinstance(value, str) and value.strip() else None
    if "user_id" in patch:
        value = patch["user_id"]
        current["user_id"] = value.strip() if isinstance(value, str) and value.strip() else None
    if "token" in patch:
        value = patch["token"]
        current["token"] = value.strip() if isinstance(value, str) and value.strip() else None
    modules = patch.get("modules")
    if isinstance(modules, dict):
        unknown = [key for key in modules if key not in _BY_ID]
        if unknown:
            raise ValueError(f"未知 CLI 模块: {', '.join(unknown)}")
        for key, row in modules.items():
            if not isinstance(row, dict):
                continue
            defaults_patch = row.get("defaults") if isinstance(row.get("defaults"), dict) else None
            merged = _module_row({**current["modules"][key], **{k: v for k, v in row.items() if k != "defaults"}})
            if defaults_patch is not None:
                defaults = dict(current["modules"][key]["defaults"])
                defaults.update({str(k): str(v) for k, v in defaults_patch.items() if v is not None})
                merged["defaults"] = defaults
            if "demo" in row and row["demo"] is None:
                merged["demo"] = None
            if "enabled" in row:
                merged["enabled"] = bool(row["enabled"])
            if isinstance(row.get("actions"), dict):
                known = set(_BY_ID[key]["actions"])
                actions = dict(current["modules"][key].get("actions") or {})
                for name, flag in row["actions"].items():
                    if name in known and isinstance(flag, bool):
                        actions[name] = flag
                merged["actions"] = actions
            current["modules"][key] = merged
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)
    logger.info(
        "cli config saved path=%s api_base_set=%s modules=%s",
        path,
        current["api_base"] is not None,
        ",".join(current["modules"]),
    )
    logger.info("cli config token_set=%s", bool(current.get("token")))
    return current


def _coalesce(saved: str | None, env_name: str, fallback: str | None) -> tuple[str | None, str]:
    if saved is not None:
        return saved, "saved"
    env = os.getenv(env_name)
    if env is not None and env.strip():
        return env.strip(), "env"
    return fallback, "default"


def public_config() -> dict[str, Any]:
    document, source = load_document()
    api_base, api_source = _coalesce(document["api_base"], "HERMES_API_URL", "http://127.0.0.1:8000")
    user_id, user_source = _coalesce(document["user_id"], "HERMES_USER_ID", None)
    token, token_source = _coalesce(document.get("token"), "HERMES_CLI_TOKEN", None)
    modules = []
    for item in MODULES:
        row = document["modules"][item["id"]]
        saved_actions = row.get("actions") or {}
        modules.append(
            {
                "id": item["id"],
                "label": item["label"],
                "command": item["command"],
                "default_key": item["default_key"],
                "actions": [
                    {
                        "id": name,
                        "label": action.get("label") or name,
                        "enabled": bool(row["enabled"] and saved_actions.get(name, True)),
                        "command": f"tpdhermes {item['command']} {name}",
                    }
                    for name, action in item["actions"].items()
                ],
                "enabled": row["enabled"],
                "demo": row["demo"],
                "defaults": row["defaults"],
            }
        )
    return {
        "module": "cli-capabilities",
        "version": "0.1.0",
        "data_source": source,
        "api_base": api_base,
        "api_base_source": api_source,
        "user_id": user_id,
        "user_id_source": user_source,
        "token_set": bool(token),
        "token_source": token_source if token else "none",
        "modules": modules,
    }


def resolve_token() -> str | None:
    """供 CLI 请求使用。不要写入日志或公开配置。"""
    document, _source = load_document()
    token, _token_source = _coalesce(document.get("token"), "HERMES_CLI_TOKEN", None)
    return token


def module_enabled(module_id: str) -> bool:
    document, _source = load_document()
    return bool(document["modules"][module_id]["enabled"])


def action_enabled(module_id: str, action: str) -> bool:
    if not module_enabled(module_id):
        return False
    document, _source = load_document()
    flags = document["modules"][module_id].get("actions") or {}
    if action in flags:
        return bool(flags[action])
    return True


def resolve_demo(module_id: str, *, demo_flag: bool, live_flag: bool) -> bool:
    if live_flag:
        return False
    if demo_flag:
        return True
    document, _source = load_document()
    saved = document["modules"][module_id]["demo"]
    if isinstance(saved, bool):
        return saved
    return os.getenv("AI_MOCK_MODE", "").strip().lower() in {"1", "true", "yes", "on"}


def resolve_param(module_id: str, key: str, explicit: str | None) -> str | None:
    if explicit is not None and explicit.strip():
        return explicit.strip()
    document, _source = load_document()
    saved = document["modules"][module_id]["defaults"].get(key)
    if isinstance(saved, str) and saved.strip():
        return saved.strip()
    return None


def _demo_items(module_id: str, action: str) -> Any:
    samples: dict[tuple[str, str], Any] = {
        ("project", "list"): [{"id": "demo-project", "name": "演示项目", "status": "active"}],
        ("project", "show"): {"id": "demo-project", "name": "演示项目", "status": "active"},
        ("cocreate", "context"): {"project_id": "demo-project", "summary": "演示共创上下文"},
        ("cocreate", "outputs"): [{"id": "demo-output", "title": "演示产出", "status": "draft"}],
        ("cocreate", "files"): [{"id": "demo-file", "name": "brief.md"}],
        ("chat", "sessions"): [{"id": "demo-session", "title": "演示对话"}],
        ("chat", "show"): {"id": "demo-session", "title": "演示对话", "messages": []},
        ("chat", "upstream"): {"available": False, "target": None, "model": "hermes-agent", "mode": "demo"},
        ("workshop", "skills"): [{"name": "demo-skill", "title": "演示技能"}],
        ("scene", "list"): [{"id": "demo-scene", "code": "demo", "name": "演示场景", "status": "published"}],
        ("scene", "show"): {"id": "demo-scene", "code": "demo", "name": "演示场景", "status": "published"},
        ("scene", "contract"): {
            "id": "demo-scene",
            "code": "demo",
            "name": "演示场景",
            "status": "published",
            "skills_policy": {},
            "output_policy": {},
        },
        ("kb", "health"): {
            "external_kb": "down",
            "cache_mode": True,
            "cached_entries": 1,
            "readonly_mode": True,
        },
        ("kb", "collections"): {"collections": ["internal.geelywiki.pages"], "source": "demo"},
        ("kb", "query"): [{"id": "demo-hit", "text": "演示检索结果"}],
        ("skill", "list"): [{"name": "demo-skill", "enabled": True, "description": "演示技能"}],
        ("skill", "show"): {"name": "demo-skill", "enabled": True, "description": "演示技能"},
        ("skill", "market"): [{"name": "demo-skill", "category": "demo"}],
        ("skill", "enable"): {"name": "demo-skill", "enabled": True},
        ("skill", "versions"): [{"version": "0.1.0", "name": "demo-skill"}],
        ("workshop", "templates"): [{"name": "demo-skill", "templates": ["默认模版"]}],
        ("workshop", "run"): {"run_id": "demo-run", "text": "演示场景输出"},
        ("chat", "ask"): {"run_id": "demo-run", "text": "演示回复"},
        ("cocreate", "ask"): {"run_id": "demo-run", "text": "演示共创回复"},
        ("scene", "preview"): {"id": "demo-scene", "status": "preview"},
        ("scene", "publish"): {"id": "demo-scene", "status": "published"},
        ("scene", "disable"): {"id": "demo-scene", "status": "disabled"},
        ("kb", "browse"): [{"name": "演示目录", "path": "02-知识库"}],
        ("kb", "query-all"): [{"id": "demo-hit", "text": "演示全库检索"}],
        ("kb", "policies"): [{"id": "demo-policy", "name": "演示策略", "status": "published"}],
        ("project", "members"): [{"user_id": "demo-user", "role": "owner"}],
        ("project", "attachments"): [{"id": "demo-file", "name": "brief.md"}],
        ("project", "outputs"): [{"id": "demo-output", "title": "演示产出"}],
        ("project", "runs"): [{"id": "demo-run", "status": "succeeded"}],
        ("project", "scenarios"): [{"id": "demo-scene", "name": "演示场景"}],
    }
    if (module_id, action) in samples:
        return samples[(module_id, action)]
    label = _BY_ID[module_id]["actions"][action].get("label") or action
    return [{"id": f"demo-{module_id}-{action}", "name": label, "status": "demo"}]


def as_items(payload: Any) -> list[Any]:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("items", "results", "skills", "collections", "catalog"):
            value = payload.get(key)
            if isinstance(value, list):
                return value
        return [payload]
    if payload is None:
        return []
    return [payload]


def invoke(
    module_id: str,
    action: str,
    params: dict[str, str | None] | None = None,
    *,
    demo_flag: bool = False,
    live_flag: bool = False,
    user_id: str | None = None,
    token: str | None = None,
    transport: Any = None,
) -> tuple[int, dict[str, Any]]:
    spec = _BY_ID.get(module_id)
    if spec is None or action not in spec["actions"]:
        return EXIT_ERROR, {
            "module": module_id,
            "action": action,
            "data_source": "none",
            "count": 0,
            "items": [],
            "warnings": ["未知命令"],
        }
    if not module_enabled(module_id):
        logger.info("cli rejected module=%s action=%s reason=disabled", module_id, action)
        return EXIT_ERROR, {
            "module": module_id,
            "action": action,
            "data_source": "saved",
            "count": 0,
            "items": [],
            "warnings": [f"{spec['label']} CLI 已在配置中关闭"],
        }
    if not action_enabled(module_id, action):
        label = spec["actions"][action].get("label") or action
        logger.info("cli rejected module=%s action=%s reason=action-disabled", module_id, action)
        return EXIT_ERROR, {
            "module": module_id,
            "action": action,
            "data_source": "saved",
            "count": 0,
            "items": [],
            "warnings": [f"{spec['label']} / {label} 已在配置中关闭"],
        }
    given = dict(params or {})
    if not (given.get("project") or "").strip() and (given.get("id") or "").strip():
        if "project" in (spec["actions"][action].get("requires") or []):
            given["project"] = given["id"]
    default_key = spec.get("default_key")
    if default_key == "project" and not (given.get("id") or "").strip():
        given["id"] = resolve_param(module_id, "project", given.get("project"))
    if default_key == "skill" and not (given.get("name") or "").strip():
        given["name"] = resolve_param(module_id, "skill", given.get("skill"))
    demo = resolve_demo(module_id, demo_flag=demo_flag, live_flag=live_flag)
    for key in spec["actions"][action].get("requires") or []:
        if key == "collection":
            continue
        if key == "enabled" and demo:
            continue
        if resolve_param(module_id, key, given.get(key)):
            continue
        if demo:
            given[key] = f"demo-{key}"
            continue
        return EXIT_ERROR, {
            "module": module_id,
            "action": action,
            "data_source": "none",
            "count": 0,
            "items": [],
            "warnings": [f"缺少参数 {key}，可在 /settings 的工作台 CLI 中配置默认值"],
        }
    if demo:
        raw = _demo_items(module_id, action)
        items = as_items(raw)
        logger.info("cli demo module=%s action=%s count=%s", module_id, action, len(items))
        code = EXIT_NO_DATA if action == "query" and not items else EXIT_OK
        return code, _envelope(module_id, action, "demo", items, raw if isinstance(raw, dict) else None)
    presented = (token or "").strip() or resolve_token()
    if not presented:
        logger.info("cli rejected module=%s action=%s reason=token-unset", module_id, action)
        return EXIT_ERROR, {
            "module": module_id,
            "action": action,
            "data_source": "saved",
            "count": 0,
            "items": [],
            "warnings": ["未设置 Agent 接入 Token。请在配置页填写，其他 Agent 凭此 Token 通过 CLI 执行指令"],
        }
    if transport is None:
        from tpdhermes.client import live_transport

        transport = live_transport
    try:
        raw = transport(spec, action, given, user_id=user_id, token=presented)
    except FileNotFoundError as exc:
        return EXIT_UPSTREAM, _fail(module_id, action, str(exc))
    except Exception as exc:  # noqa: BLE001 — 转成稳定退出码
        status = getattr(exc, "status_code", None)
        code = EXIT_NO_DATA if status == 404 else EXIT_UPSTREAM
        logger.info("cli upstream fail module=%s action=%s status=%s", module_id, action, status)
        return code, _fail(module_id, action, str(exc))
    items = as_items(raw)
    code = EXIT_NO_DATA if action == "query" and not items else EXIT_OK
    if action in {"show", "contract", "context"} and not items:
        code = EXIT_NO_DATA
    logger.info("cli live module=%s action=%s count=%s", module_id, action, len(items))
    detail = raw if isinstance(raw, dict) and not isinstance(raw.get("items"), list) else None
    return code, _envelope(module_id, action, "live", items, detail)


def _envelope(
    module_id: str,
    action: str,
    data_source: str,
    items: list[Any],
    detail: dict[str, Any] | None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "module": module_id,
        "action": action,
        "version": "0.1.0",
        "data_source": data_source,
        "count": len(items),
        "items": items,
        "warnings": [],
    }
    if detail:
        payload["detail"] = {k: v for k, v in detail.items() if k not in {"items", "results", "skills"}}
    return payload


def _fail(module_id: str, action: str, message: str) -> dict[str, Any]:
    return {
        "module": module_id,
        "action": action,
        "version": "0.1.0",
        "data_source": "live",
        "count": 0,
        "items": [],
        "warnings": [message],
    }
