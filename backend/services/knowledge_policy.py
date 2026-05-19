"""
Knowledge write policy — 可按项目 / 场景限制允许写入的 collection。

当前实现（编排落地前兼容）：
- 环境变量 KNOWLEDGE_HARVEST_WRITE_ALLOWED_COLLECTIONS：逗号分隔集合名；为空则放行全部。
- 可选 JSON KNOWLEDGE_HARVEST_WRITE_POLICY（预留 scenario/project）：

  {"scenario_overrides":{"tech-solution":["col.a"]},
   "project_overrides":{"7":["col.b"]},
   "default_allowed":["col.c"]}

project_overrides / scenario_overrides 命中时与 default_allowed 合并为有效白名单。
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Optional

logger = logging.getLogger("tpdx.hermes")


def _parse_csv_allowlist(raw: str) -> list[str]:
    return [x.strip() for x in (raw or "").split(",") if x.strip()]


def _load_json_policy() -> dict[str, Any]:
    raw = os.getenv("KNOWLEDGE_HARVEST_WRITE_POLICY", "").strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        logger.warning("KNOWLEDGE_HARVEST_WRITE_POLICY JSON 解析失败，忽略")
        return {}


def get_allowed_write_collections(
    *,
    project_id: str,
    scenario_id: Optional[str] = None,
) -> Optional[list[str]]:
    """
    返回 None 表示不限制（允许任意 collection）。
    非 None 时为白名单列表（非空则 collection 必须在其中）。
    """
    env_flat = os.getenv("KNOWLEDGE_HARVEST_WRITE_ALLOWED_COLLECTIONS", "").strip()
    policy = _load_json_policy()

    merged: list[str] = []

    if env_flat:
        merged.extend(_parse_csv_allowlist(env_flat))

    default_allowed = policy.get("default_allowed")
    if isinstance(default_allowed, list):
        merged.extend(str(x).strip() for x in default_allowed if str(x).strip())

    proj_key = str(project_id).strip()
    po = policy.get("project_overrides")
    if isinstance(po, dict) and proj_key in po:
        lst = po[proj_key]
        if isinstance(lst, list):
            merged.extend(str(x).strip() for x in lst if str(x).strip())

    if scenario_id:
        so = policy.get("scenario_overrides")
        if isinstance(so, dict) and str(scenario_id).strip() in so:
            lst = so[str(scenario_id).strip()]
            if isinstance(lst, list):
                merged.extend(str(x).strip() for x in lst if str(x).strip())

    if merged:
        # 去重保持顺序
        seen: set[str] = set()
        out: list[str] = []
        for x in merged:
            if x not in seen:
                seen.add(x)
                out.append(x)
        return out
    return None


def validate_harvest_collection(
    collection_name: str,
    *,
    project_id: str,
    scenario_id: Optional[str] = None,
) -> tuple[bool, Optional[str], Optional[list[str]]]:
    allowed = get_allowed_write_collections(project_id=project_id, scenario_id=scenario_id)
    if allowed is None:
        return True, None, None
    if collection_name.strip() in allowed:
        return True, None, allowed
    return False, "collection_not_allowed", allowed
