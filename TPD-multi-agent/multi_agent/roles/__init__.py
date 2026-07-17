"""可复用角色 Agent 目录（供 Pack 引用 / 合并）。"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

import yaml

from multi_agent.utils.errors import MultiAgentError

logger = logging.getLogger("multi_agent.roles")

ROLES_ROOT = Path(__file__).resolve().parent
ROLE_ID_RE = re.compile(r"^[a-z][a-z0-9_]*$")
VALID_KINDS = frozenset({"roundtable", "consult"})


def validate_role_id(role_id: str) -> str:
    rid = (role_id or "").strip().lower()
    if not ROLE_ID_RE.match(rid):
        raise MultiAgentError("role id 须为 snake_case，如 tech_hardcore、moderator")
    return rid


def _role_path(role_id: str) -> Path:
    return ROLES_ROOT / f"{role_id}.yml"


def list_role_ids() -> list[str]:
    return sorted(
        p.stem
        for p in ROLES_ROOT.glob("*.yml")
        if p.is_file() and not p.name.startswith("._") and ROLE_ID_RE.match(p.stem)
    )


def list_roles_meta() -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for rid in list_role_ids():
        try:
            data = load_role(rid)
            items.append(
                {
                    "id": data["id"],
                    "name": data.get("name") or rid,
                    "description": data.get("description") or "",
                    "kinds": list(data.get("kinds") or []),
                }
            )
        except MultiAgentError as exc:
            logger.warning("跳过无效 role %s: %s", rid, exc)
    return items


def load_role(role_id: str) -> dict[str, Any]:
    rid = validate_role_id(role_id)
    path = _role_path(rid)
    if not path.is_file():
        raise MultiAgentError(f"未知 role: {rid}")
    with path.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    if not isinstance(data, dict):
        raise MultiAgentError(f"无效 role 文件: {path}")
    return normalize_role({**data, "id": data.get("id") or rid})


def load_roles_index() -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for rid in list_role_ids():
        try:
            role = load_role(rid)
            out[role["id"]] = role
        except MultiAgentError as exc:
            logger.warning("跳过无效 role %s: %s", rid, exc)
    return out


def normalize_role(payload: dict[str, Any]) -> dict[str, Any]:
    rid = validate_role_id(str(payload.get("id") or ""))
    name = str(payload.get("name") or "").strip()
    if not name:
        raise MultiAgentError("role 需要 name")
    raw_kinds = payload.get("kinds") or []
    if isinstance(raw_kinds, str):
        raw_kinds = [raw_kinds]
    if not isinstance(raw_kinds, list) or not raw_kinds:
        raise MultiAgentError("kinds 至少包含 roundtable 或 consult")
    kinds = []
    for k in raw_kinds:
        kk = str(k).strip().lower()
        if kk not in VALID_KINDS:
            raise MultiAgentError(f"无效 kind: {k}")
        if kk not in kinds:
            kinds.append(kk)

    role = {
        "id": rid,
        "name": name,
        "description": str(payload.get("description") or "").strip(),
        "kinds": kinds,
        "perspective": str(payload.get("perspective") or "").strip(),
        "system": str(payload.get("system") or "").strip(),
        "tool": str(payload.get("tool") or "").strip(),
        "when": str(payload.get("when") or "").strip(),
    }
    if "consult" in kinds and not role["tool"]:
        role["tool"] = f"consult_{rid}"
    return role


def to_roundtable_slot(role: dict[str, Any]) -> dict[str, str]:
    return {
        "id": role["id"],
        "name": role["name"],
        "perspective": role.get("perspective") or "",
        **({"system": role["system"]} if role.get("system") else {}),
    }


def to_consult_slot(role: dict[str, Any]) -> dict[str, str]:
    return {
        "id": role["id"],
        "name": role["name"],
        "tool": role.get("tool") or f"consult_{role['id']}",
        "when": role.get("when") or "",
        **({"system": role["system"]} if role.get("system") else {}),
    }


def save_role(payload: dict[str, Any], *, create: bool = False) -> dict[str, Any]:
    data = normalize_role(payload)
    rid = data["id"]
    path = _role_path(rid)
    exists = path.is_file()
    if create and exists:
        raise MultiAgentError(f"role 已存在: {rid}")
    if not create and not exists:
        raise MultiAgentError(f"未知 role: {rid}")
    dump = {k: v for k, v in data.items() if v or k in {"id", "name", "kinds"}}
    text = yaml.safe_dump(dump, allow_unicode=True, sort_keys=False, default_flow_style=False)
    path.write_text(text, encoding="utf-8")
    logger.info("已保存 role id=%s path=%s create=%s", rid, path, create and not exists)
    return load_role(rid)


def delete_role(role_id: str) -> None:
    rid = validate_role_id(role_id)
    path = _role_path(rid)
    if not path.is_file():
        raise MultiAgentError(f"未知 role: {rid}")
    path.unlink()
    logger.info("已删除 role id=%s", rid)


def merge_role_overlay(base: dict[str, Any], overlay: dict[str, Any]) -> dict[str, Any]:
    """Pack 内联字段非空时覆盖角色库。"""
    out = dict(base)
    for key, val in overlay.items():
        if val is None:
            continue
        if isinstance(val, str) and not val.strip():
            continue
        out[key] = val
    return out
