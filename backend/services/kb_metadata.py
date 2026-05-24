"""
Chroma 写入侧会把 list/dict 序列化为 JSON 字符串；同步到 kb_cache 与浏览树前在此处统一还原，
保证 tags、linked_kg_ids、project_ids 等与前端约定一致。
"""

from __future__ import annotations

import json
from typing import Any

# 与 chroma_sanitize_metadata 写入的「非标量→JSON 字符串」对称
_KB_JSON_DECODE_KEYS = frozenset(
    {"tags", "linked_kg_ids", "project_ids", "projects", "authors"}
)


def normalize_kb_metadata_dict(meta: dict[str, Any] | None) -> dict[str, Any]:
    """将 kb metadata 规范为「页面 / browse-tree」可用的 Python 类型。"""
    if not meta:
        return {}
    out: dict[str, Any] = dict(meta)

    for key in _KB_JSON_DECODE_KEYS:
        val = out.get(key)
        if isinstance(val, str) and val.strip():
            s = val.strip()
            if s.startswith(("[", "{")):
                try:
                    parsed = json.loads(s)
                    out[key] = parsed
                except json.JSONDecodeError:
                    pass

    for pk in ("project_ids", "projects"):
        v = out.get(pk)
        if isinstance(v, list):
            nums: list[int] = []
            for x in v:
                try:
                    nums.append(int(x))
                except (TypeError, ValueError):
                    continue
            out[pk] = nums

    pub = out.get("published")
    if isinstance(pub, str):
        out["published"] = pub.strip().lower() in ("1", "true", "yes", "on")
    elif isinstance(pub, (int, float)) and not isinstance(pub, bool):
        out["published"] = pub != 0

    return out
