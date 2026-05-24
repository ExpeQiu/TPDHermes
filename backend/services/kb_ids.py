"""kb_cache / Chroma 条目 id 与 doc_id 互转。"""

from __future__ import annotations

import re

_CHUNK_ID_SUFFIX = re.compile(r"^(.+)_chunk_\d+$", re.IGNORECASE)


def kb_doc_id_from_ref(ref: str) -> str:
    """将 cache 主键或 chunk id 规范为逻辑 doc_id。"""
    s = (ref or "").strip()
    if not s:
        return ""
    m = _CHUNK_ID_SUFFIX.match(s)
    return m.group(1).strip() if m else s


def is_kb_chunk_cache_id(ref: str) -> bool:
    s = (ref or "").strip()
    return bool(s and _CHUNK_ID_SUFFIX.match(s))
