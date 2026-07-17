"""Skill Pack 加载与保存。"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

import yaml

from multi_agent.utils.errors import MultiAgentError

logger = logging.getLogger("multi_agent.skill_packs")

PACKS_ROOT = Path(__file__).resolve().parent
PACK_ID_RE = re.compile(r"^[a-z][a-z0-9]*(-[a-z0-9]+)*$")


def list_packs() -> list[str]:
    return sorted(
        p.name.replace("_", "-")
        for p in PACKS_ROOT.iterdir()
        if p.is_dir() and (p / "pack.yml").is_file()
    )


def list_packs_meta() -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for pack_id in list_packs():
        try:
            data = load_pack(pack_id)
            items.append(
                {
                    "id": pack_id,
                    "name": data.get("name") or pack_id,
                    "description": data.get("description") or "",
                    "roles": len(data.get("roundtable_roles") or []),
                    "experts": len(data.get("consult_experts") or []),
                }
            )
        except MultiAgentError as exc:
            logger.warning("跳过无效 pack %s: %s", pack_id, exc)
    return items


def validate_pack_id(pack_id: str) -> str:
    pid = (pack_id or "").strip().lower()
    if not PACK_ID_RE.match(pid):
        raise MultiAgentError(
            "pack id 须为 kebab-case，如 nev-tech、content-lab"
        )
    return pid


def _pack_dir(pack_id: str) -> Path:
    name = pack_id.replace("-", "_")
    path = PACKS_ROOT / name
    if not (path / "pack.yml").is_file():
        raise MultiAgentError(f"未知 skill pack: {pack_id}")
    return path


def load_pack(pack_id: str) -> dict[str, Any]:
    pid = validate_pack_id(pack_id)
    path = _pack_dir(pid) / "pack.yml"
    with path.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    if not isinstance(data, dict):
        raise MultiAgentError(f"无效 pack 文件: {path}")
    data["id"] = data.get("id") or pid
    data = _merge_catalog_roles(data)
    data["_path"] = str(path.parent)
    return data


def _merge_catalog_roles(data: dict[str, Any]) -> dict[str, Any]:
    """用角色库补全 Pack 席位；Pack 非空字段优先。"""
    try:
        from multi_agent.roles import (
            load_roles_index,
            merge_role_overlay,
            to_consult_slot,
            to_roundtable_slot,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("角色库不可用，跳过合并: %s", exc)
        return data

    catalog = load_roles_index()
    if not catalog:
        return data

    roles_out: list[dict[str, Any]] = []
    for item in data.get("roundtable_roles") or []:
        if not isinstance(item, dict):
            continue
        rid = str(item.get("id") or "").strip()
        base = catalog.get(rid)
        if base and "roundtable" in (base.get("kinds") or []):
            merged = merge_role_overlay(to_roundtable_slot(base), item)
            roles_out.append(merged)
        else:
            roles_out.append(item)
    if roles_out:
        data["roundtable_roles"] = roles_out

    experts_out: list[dict[str, Any]] = []
    for item in data.get("consult_experts") or []:
        if not isinstance(item, dict):
            continue
        rid = str(item.get("id") or "").strip()
        base = catalog.get(rid)
        if base and "consult" in (base.get("kinds") or []):
            merged = merge_role_overlay(to_consult_slot(base), item)
            experts_out.append(merged)
        else:
            experts_out.append(item)
    if experts_out:
        data["consult_experts"] = experts_out
    return data


def _clean_roles(raw: Any, *, kind: str) -> list[dict[str, str]]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise MultiAgentError(f"{kind} 必须是数组")
    out: list[dict[str, str]] = []
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            raise MultiAgentError(f"{kind}[{i}] 必须是对象")
        rid = str(item.get("id") or "").strip()
        name = str(item.get("name") or "").strip()
        if not rid or not name:
            raise MultiAgentError(f"{kind}[{i}] 需要 id 与 name")
        row: dict[str, str] = {"id": rid, "name": name}
        if kind == "roundtable_roles":
            row["perspective"] = str(item.get("perspective") or "").strip()
        else:
            row["tool"] = str(item.get("tool") or f"consult_{rid}").strip()
            row["when"] = str(item.get("when") or "").strip()
        out.append(row)
    return out


def normalize_pack(payload: dict[str, Any], *, pack_id: str | None = None) -> dict[str, Any]:
    pid = validate_pack_id(str(payload.get("id") or pack_id or ""))
    name = str(payload.get("name") or "").strip() or pid
    description = str(payload.get("description") or "").strip()
    roles = _clean_roles(payload.get("roundtable_roles"), kind="roundtable_roles")
    experts = _clean_roles(payload.get("consult_experts"), kind="consult_experts")
    if not any(r.get("id") == "moderator" for r in roles):
        roles.append(
            {
                "id": "moderator",
                "name": "主持人",
                "perspective": "控场、升维冲突、收束可执行方案",
            }
        )
    return {
        "id": pid,
        "name": name,
        "description": description,
        "roundtable_roles": roles,
        "consult_experts": experts,
    }


def save_pack(payload: dict[str, Any], *, create: bool = False) -> dict[str, Any]:
    data = normalize_pack(payload)
    pid = data["id"]
    dir_path = PACKS_ROOT / pid.replace("-", "_")
    yml_path = dir_path / "pack.yml"
    exists = yml_path.is_file()
    if create and exists:
        raise MultiAgentError(f"pack 已存在: {pid}")
    if not create and not exists:
        raise MultiAgentError(f"未知 skill pack: {pid}")

    dir_path.mkdir(parents=True, exist_ok=True)
    dump = {
        "id": data["id"],
        "name": data["name"],
        "description": data["description"],
        "roundtable_roles": data["roundtable_roles"],
        "consult_experts": data["consult_experts"],
    }
    text = yaml.safe_dump(dump, allow_unicode=True, sort_keys=False, default_flow_style=False)
    yml_path.write_text(text, encoding="utf-8")
    logger.info("已保存 skill pack id=%s path=%s create=%s", pid, yml_path, create and not exists)
    saved = load_pack(pid)
    return {k: v for k, v in saved.items() if not str(k).startswith("_")}
