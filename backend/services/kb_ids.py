"""kb_cache / Chroma 条目 id 与 doc_id 互转。"""

from __future__ import annotations

import hashlib
import re

_CHUNK_ID_SUFFIX = re.compile(r"^(.+)_chunk_\d+$", re.IGNORECASE)
_STAGE_SUFFIX = re.compile(r"__stage__.+$")


def source_chunk_from_cache_id(cache_id: str) -> str:
    """本地主键是 project::collection::source_chunk_id；旧行主键就是源 chunk id。"""
    s = (cache_id or "").strip()
    parts = s.split("::")
    if len(parts) >= 3:
        return "::".join(parts[2:])
    return s


def cache_row_id(project_id: str, collection: str, source_chunk_id: str) -> str:
    pid = (project_id or "").strip() or "__all__"
    col = (collection or "").strip()
    src = (source_chunk_id or "").strip()
    return f"{pid}::{col}::{src}"


def catalog_index_doc_id(
    *,
    scope: str,
    project_id: str,
    collection: str,
    folder: str,
) -> str:
    raw = "\n".join(
        [
            (scope or "").strip(),
            (project_id or "").strip(),
            (collection or "").strip(),
            (folder or "").strip(),
        ]
    )
    return "pathcat_" + hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def folder_catalog_item_id(
    *,
    scope: str,
    project_id: str,
    collection: str,
    folder: str,
) -> str:
    digest = catalog_index_doc_id(
        scope=scope,
        project_id=project_id,
        collection=collection,
        folder=folder,
    )
    return f"folder:{digest}"


def kb_doc_id_from_ref(ref: str) -> str:
    """将 cache 主键或 chunk id 规范为逻辑 doc_id。"""
    s = source_chunk_from_cache_id(ref)
    if not s:
        return ""
    s = _STAGE_SUFFIX.sub("", s)
    m = _CHUNK_ID_SUFFIX.match(s)
    return m.group(1).strip() if m else s


def is_kb_chunk_cache_id(ref: str) -> bool:
    s = (ref or "").strip()
    return bool(s and _CHUNK_ID_SUFFIX.match(s))
