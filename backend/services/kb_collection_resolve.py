"""知识库 collection 名称解析：与 kb_list_collections 对齐，纠正短名称误用。"""

from __future__ import annotations

import logging
from typing import Optional

from backend.services.kb_proxy import kb_proxy_service

logger = logging.getLogger("tpdx.hermes.kb_resolve")


async def resolve_collection_name(
    collection_name: str,
    *,
    project_id: Optional[str] = None,
) -> tuple[str, Optional[str]]:
    """
    将 collection_name 解析为 Chroma 中的完整名称。

    Returns:
        (resolved_name, warning) — warning 非空时表示发生了自动修正或调用方应修正参数。
    """
    raw = str(collection_name or "").strip()
    if not raw:
        return raw, "collection_name 为空；请先调用 kb_list_collections"

    listed = await kb_proxy_service.list_collections(project_id=project_id)
    names = [str(c).strip() for c in (listed.get("collections") or []) if c]

    if raw in names:
        return raw, None

    candidates: list[str] = []
    for n in names:
        if n == raw or n.endswith("." + raw):
            candidates.append(n)
            continue
        if n.split(".")[-1] == raw:
            candidates.append(n)

    # 去重保序
    seen: set[str] = set()
    unique: list[str] = []
    for c in candidates:
        if c not in seen:
            seen.add(c)
            unique.append(c)

    if len(unique) == 1:
        resolved = unique[0]
        warning = (
            f"collection_name 已自动修正：{raw!r} -> {resolved!r}；"
            "后续请直接使用 kb_list_collections 返回的完整名称。"
        )
        logger.info("kb collection resolved %r -> %r", raw, resolved)
        return resolved, warning

    preview = ", ".join(names[:8])
    if len(unique) > 1:
        return raw, (
            f"collection_name {raw!r} 对应多个集合：{', '.join(unique)}；"
            "请从 kb_list_collections 中选择唯一完整名称。"
        )

    if "." not in raw:
        return raw, (
            f"collection_name {raw!r} 为短名称且未匹配任何集合（缺少 public./project. 前缀）；"
            f"可用集合示例：{preview}"
        )

    return raw, f"collection_name {raw!r} 不存在；可用集合示例：{preview}"


def merge_kb_warnings(*parts: Optional[str]) -> Optional[str]:
    texts = [p.strip() for p in parts if p and str(p).strip()]
    return " | ".join(texts) if texts else None
