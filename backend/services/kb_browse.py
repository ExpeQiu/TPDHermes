"""
从 kb_cache 聚合只读目录树，供 /kb/browse-tree 使用。
"""

from __future__ import annotations

import json
import logging
from typing import Any

from backend.services.kb_cache import kb_cache_service
from backend.services.kb_ids import kb_doc_id_from_ref
from backend.services.kb_metadata import normalize_kb_metadata_dict

logger = logging.getLogger("tpdx.hermes")

# 单请求聚合上限，避免一次性载入过大
DEFAULT_TREE_ENTRY_LIMIT = 3000
MAX_TREE_ENTRY_LIMIT = 8000


def _as_str_list(val: Any) -> list[str]:
    if val is None:
        return []
    if isinstance(val, list):
        return [str(x) for x in val if x is not None]
    if isinstance(val, str) and val:
        s = val.strip()
        if s.startswith("["):
            try:
                j = json.loads(s)
                if isinstance(j, list):
                    return [str(x) for x in j if x is not None]
            except json.JSONDecodeError:
                pass
        return [val]
    return []


def _parse_metadata(raw: dict[str, Any]) -> dict[str, Any]:
    raw = normalize_kb_metadata_dict(dict(raw))
    domain = raw.get("domain")
    if not (isinstance(domain, str) and domain.strip()):
        domain = "_uncategorized"
    else:
        domain = domain.strip()

    folder_path = raw.get("folder_path")
    if not (isinstance(folder_path, str) and folder_path.strip()):
        folder_path = ""
    else:
        folder_path = folder_path.strip().strip("/")

    title = raw.get("title")
    if not (isinstance(title, str) and title.strip()):
        title = ""

    tags = _as_str_list(raw.get("tags"))

    published = raw.get("published")
    if not isinstance(published, bool):
        published = True

    linked = _as_str_list(raw.get("linked_kg_ids"))

    source_url = raw.get("source_url")
    source_url = source_url if isinstance(source_url, str) else ""

    return {
        "domain": domain,
        "folder_path": folder_path,
        "title": title,
        "tags": tags,
        "published": published,
        "linked_kg_ids": linked,
        "source_url": source_url,
    }


def _tree_insert(
    root: dict[str, Any],
    parts: list[str],
    doc: dict[str, Any],
    path_prefix: str,
) -> None:
    if not parts:
        root.setdefault("documents", []).append(doc)
        return
    key = parts[0]
    rest = parts[1:]
    full_path = f"{path_prefix}/{key}" if path_prefix else key
    children: dict[str, Any] = root.setdefault("children", {})
    if key not in children:
        children[key] = {
            "segment": key,
            "path": full_path,
            "children": {},
            "documents": [],
        }
    node = children[key]
    if "children" not in node or not isinstance(node["children"], dict):
        node["children"] = {}
    _tree_insert(node, rest, doc, full_path)


def _serialize_node(node: dict[str, Any]) -> dict[str, Any]:
    child_map = node.get("children") or {}
    if isinstance(child_map, dict):
        child_list = sorted(
            (_serialize_node(ch) for ch in child_map.values()),
            key=lambda x: x.get("segment", ""),
        )
    else:
        child_list = []
    here = len(node.get("documents", []))
    nested = sum(ch.get("total_documents", 0) for ch in child_list)
    total = here + nested
    return {
        "segment": node.get("segment", ""),
        "path": node.get("path", ""),
        "domain": node.get("domain"),
        "document_count": total,
        "total_documents": total,
        "documents": node.get("documents", []),
        "children": child_list,
    }


async def build_browse_tree(
    *,
    project_id: str,
    domain_filter: str | None,
    collection: str | None,
    limit: int,
) -> dict[str, Any]:
    """
    聚合 kb_cache 条目为「域 → 路径树 → 文档」结构。
    """
    lim = max(1, min(limit or DEFAULT_TREE_ENTRY_LIMIT, MAX_TREE_ENTRY_LIMIT))
    domains: dict[str, dict[str, Any]] = {}
    matched_count = 0
    entry_count_scanned = 0
    offset = 0
    batch_size = min(1000, max(200, lim))
    truncated = False

    while True:
        fetch_size = min(batch_size, MAX_TREE_ENTRY_LIMIT - entry_count_scanned)
        if fetch_size <= 0:
            truncated = True
            break
        batch = await kb_cache_service.get_cached_entries(
            project_id=project_id,
            collection=collection,
            limit=fetch_size,
            offset=offset,
        )
        if not batch:
            break

        entry_count_scanned += len(batch)
        offset += len(batch)

        for row in batch:
            meta_raw = row.get("metadata") or {}
            if isinstance(meta_raw, str):
                try:
                    meta_raw = json.loads(meta_raw)
                except json.JSONDecodeError:
                    meta_raw = {}
            parsed = _parse_metadata(meta_raw if isinstance(meta_raw, dict) else {})

            if domain_filter and parsed["domain"] != domain_filter:
                continue

            matched_count += 1
            if matched_count > lim:
                truncated = True
                break

            dom_name = parsed["domain"]
            if dom_name not in domains:
                domains[dom_name] = {
                    "domain": dom_name,
                    "segment": "",
                    "path": "",
                    "children": {},
                    "documents": [],
                }

            folder_parts = [p for p in parsed["folder_path"].split("/") if p] if parsed["folder_path"] else []

            title = parsed["title"] or (row.get("content") or "")[:80] or row.get("id", "未命名")
            row_id = str(row.get("id") or "").strip()
            meta_doc = meta_raw.get("doc_id") if isinstance(meta_raw, dict) else None
            doc_id = (
                meta_doc.strip()
                if isinstance(meta_doc, str) and meta_doc.strip()
                else kb_doc_id_from_ref(row_id)
            )

            doc = {
                "id": row_id,
                "doc_id": doc_id,
                "project_id": row.get("project_id"),
                "collection": row.get("collection"),
                "title": title,
                "folder_path": parsed["folder_path"],
                "domain": dom_name,
                "tags": parsed["tags"],
                "published": parsed["published"],
                "linked_kg_ids": parsed["linked_kg_ids"],
                "source_url": parsed["source_url"],
                "source": row.get("source"),
                "updated_at": row.get("updated_at"),
                "summary": (row.get("content") or "")[:280],
            }

            dom_root = domains[dom_name]
            _tree_insert(dom_root, folder_parts, doc, path_prefix="")

            if not domain_filter and matched_count >= lim:
                truncated = True
                break

        if truncated:
            break
        if len(batch) < fetch_size:
            break
        if entry_count_scanned >= MAX_TREE_ENTRY_LIMIT:
            truncated = True
            break

    domain_list = []
    for _dkey, dom in sorted(domains.items(), key=lambda x: x[0]):
        dom["domain"] = dom.get("domain", _dkey)
        serialized = _serialize_node(dom)
        serialized["domain"] = dom["domain"]
        domain_list.append(serialized)

    return {
        "domains": domain_list,
        "entry_count_scanned": entry_count_scanned,
        "truncated": truncated,
        "limit": lim,
    }
