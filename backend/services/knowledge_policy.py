"""
Knowledge policy 解析：
- 兼容旧环境变量白名单
- 支持项目 / 场景绑定可配置 KnowledgePolicy 实体
- 支持场景仍使用内嵌 knowledge_policy_json
"""

from __future__ import annotations

import logging
import os
from typing import Any, Optional

from backend.db import async_session_maker
from backend.models.knowledge_policy import KnowledgePolicy
from backend.models.project import Project
from backend.models.scenario_profile import ScenarioProfile
from backend.services.knowledge_policy_store import (
    loads_json_dict,
    normalize_policy_config,
)

logger = logging.getLogger("tpdx.hermes")


def _parse_csv_allowlist(raw: str) -> list[str]:
    return [x.strip() for x in (raw or "").split(",") if x.strip()]


def _load_json_policy() -> dict[str, Any]:
    import json

    raw = os.getenv("KNOWLEDGE_HARVEST_WRITE_POLICY", "").strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        logger.warning("KNOWLEDGE_HARVEST_WRITE_POLICY JSON 解析失败，忽略")
        return {}


def _extract_allowed_from_config(config: dict[str, Any] | None) -> list[str]:
    cfg = normalize_policy_config(config or {})
    write_control = cfg.get("write_control")
    out: list[str] = []
    if isinstance(write_control, dict):
        allowed = write_control.get("allowed_collections")
        if isinstance(allowed, list):
            out.extend(str(x).strip() for x in allowed if str(x).strip())
    top = cfg.get("write_allowed_collections")
    if isinstance(top, list):
        out.extend(str(x).strip() for x in top if str(x).strip())
    return out


async def _load_entity_policy(policy_id: str | None) -> dict[str, Any]:
    if not policy_id:
        return {}
    async with async_session_maker() as db:
        row = await db.get(KnowledgePolicy, policy_id)
    if not row:
        return {}
    if row.status not in {"approved", "published"}:
        return {}
    return loads_json_dict(row.config_json)


async def resolve_effective_knowledge_policy(
    *,
    project_id: str,
    scenario_id: Optional[str] = None,
) -> dict[str, Any]:
    env_flat = os.getenv("KNOWLEDGE_HARVEST_WRITE_ALLOWED_COLLECTIONS", "").strip()
    legacy_policy = _load_json_policy()

    merged: dict[str, Any] = {}
    write_allow: list[str] = []

    if env_flat:
        write_allow.extend(_parse_csv_allowlist(env_flat))

    default_allowed = legacy_policy.get("default_allowed")
    if isinstance(default_allowed, list):
        write_allow.extend(str(x).strip() for x in default_allowed if str(x).strip())

    proj_key = str(project_id).strip()
    async with async_session_maker() as db:
        project_row = None
        if proj_key and proj_key not in {"__all__", "*", "all"}:
            project_row = await db.get(Project, proj_key)
        scenario_row = None
        if scenario_id:
            scenario_row = await db.get(ScenarioProfile, str(scenario_id).strip())

    if project_row and project_row.knowledge_policy_id:
        project_cfg = await _load_entity_policy(project_row.knowledge_policy_id)
        merged.update(project_cfg)
        write_allow.extend(_extract_allowed_from_config(project_cfg))

    po = legacy_policy.get("project_overrides")
    if isinstance(po, dict) and proj_key in po:
        lst = po[proj_key]
        if isinstance(lst, list):
            write_allow.extend(str(x).strip() for x in lst if str(x).strip())

    if scenario_row:
        if scenario_row.knowledge_policy_id:
            scenario_cfg = await _load_entity_policy(scenario_row.knowledge_policy_id)
            merged.update(scenario_cfg)
            write_allow.extend(_extract_allowed_from_config(scenario_cfg))
        else:
            inline_cfg = loads_json_dict(scenario_row.knowledge_policy_json)
            if inline_cfg:
                merged.update(inline_cfg)
                write_allow.extend(_extract_allowed_from_config(inline_cfg))

        so = legacy_policy.get("scenario_overrides")
        sid = str(scenario_id).strip()
        if isinstance(so, dict) and sid in so:
            lst = so[sid]
            if isinstance(lst, list):
                write_allow.extend(str(x).strip() for x in lst if str(x).strip())

    if write_allow:
        seen: set[str] = set()
        out: list[str] = []
        for x in write_allow:
            if x not in seen:
                seen.add(x)
                out.append(x)
        merged["write_control"] = {
            **(merged.get("write_control") if isinstance(merged.get("write_control"), dict) else {}),
            "allowed_collections": out,
        }
    return merged


async def get_allowed_write_collections(
    *,
    project_id: str,
    scenario_id: Optional[str] = None,
) -> Optional[list[str]]:
    """
    返回 None 表示不限制（允许任意 collection）。
    非 None 时为白名单列表（非空则 collection 必须在其中）。
    """
    config = await resolve_effective_knowledge_policy(
        project_id=project_id,
        scenario_id=scenario_id,
    )
    allowed = _extract_allowed_from_config(config)
    if allowed:
        return allowed
    return None


async def validate_harvest_collection(
    collection_name: str,
    *,
    project_id: str,
    scenario_id: Optional[str] = None,
) -> tuple[bool, Optional[str], Optional[list[str]]]:
    allowed = await get_allowed_write_collections(project_id=project_id, scenario_id=scenario_id)
    if allowed is None:
        return True, None, None
    if collection_name.strip() in allowed:
        return True, None, allowed
    return False, "collection_not_allowed", allowed
