"""离线缓存的词法相关性。无关问题返回 0，不把任意缓存当成命中。"""

from __future__ import annotations

import re

_CJK_RUN = re.compile(r"[\u4e00-\u9fff]{2,}")
_TOKEN = re.compile(r"[A-Za-z0-9_]{2,}|[\u4e00-\u9fff]{2,}")


def lexical_terms(query: str) -> list[str]:
    text = (query or "").strip().lower()
    if not text:
        return []
    terms = [m.group(0) for m in _TOKEN.finditer(text)]
    if text not in terms:
        terms.append(text)
    return terms


def lexical_score(query: str, content: str) -> int:
    q = (query or "").strip()
    body = (content or "")
    if not q or not body:
        return 0
    lowered = body.lower()
    score = 0
    if q.lower() in lowered:
        score += 10
    for term in lexical_terms(q):
        if term and term in lowered:
            score += 1
    for phrase in _CJK_RUN.findall(q):
        if phrase in body:
            score += 2
    return score


def is_catalog_metadata(meta: dict | None) -> bool:
    data = meta or {}
    source_type = str(data.get("source_type") or "")
    doc_id = str(data.get("doc_id") or "")
    if source_type == "catalog_index":
        return True
    return doc_id.startswith("pathcat_") or doc_id.startswith("colcat_")
