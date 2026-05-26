"""
Knowledge Base Tools for TPDHermes MCP Server

Wraps kb_proxy_service and kb_cache_service for MCP access.
"""

import os
import re
import logging
import math
from typing import Any, Optional

from backend.services.kb_proxy import kb_proxy_service
from backend.services.kb_cache import kb_cache_service
from backend.services.kb_write import add_kb_harvest_entry
from backend.services.kb_collection_resolve import merge_kb_warnings, resolve_collection_name
from backend.services.project_kb import is_project_kb_collection

logger = logging.getLogger(__name__)


async def _record_kb_miss_if_empty(
    result: dict[str, Any],
    *,
    query: str,
    collection: str,
    project_id: Optional[str],
) -> None:
    if int(result.get("count") or 0) > 0:
        return
    try:
        from backend.db import async_session_maker
        from backend.services.learning_service import record_kb_miss

        async with async_session_maker() as db:
            await record_kb_miss(
                db,
                query=query,
                collection=collection,
                project_id=project_id,
            )
    except Exception as exc:
        logger.debug("kb_miss record skipped: %s", exc)


def _metadata_published(meta: dict) -> bool:
    pub = (meta or {}).get("published")
    if isinstance(pub, bool):
        return pub
    if isinstance(pub, str):
        return pub.strip().lower() in ("1", "true", "yes", "on")
    return bool(pub)


def _filter_project_kb_results(result: dict, collection_name: str) -> dict:
    if not is_project_kb_collection(collection_name):
        return result
    rows = result.get("results") or []
    kept = [r for r in rows if _metadata_published((r or {}).get("metadata") or {})]
    out = dict(result)
    out["results"] = kept
    out["count"] = len(kept)
    return out


async def kb_query(
    query: str,
    collection_name: str,
    limit: int = 10,
    project_id: Optional[str] = None,
) -> dict:
    """
    Query the knowledge base.

    Args:
        query: Query text (used for embedding similarity search)
        collection_name: ChromaDB collection name to query
        limit: Maximum number of results to return
        project_id: Optional project ID to filter results

    Returns:
        {
            "results": [{"content": str, "metadata": dict, "distance": float}, ...],
            "source": "chroma" | "cache",
            "count": int,
            "warning": Optional[str]
        }
    """
    resolved_name, resolve_warning = await resolve_collection_name(
        collection_name,
        project_id=project_id,
    )

    def _to_text(row: dict[str, Any]) -> str:
        meta = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
        parts = [
            str(row.get("content") or ""),
            str((meta or {}).get("title") or ""),
            str((meta or {}).get("summary") or ""),
        ]
        return "\n".join(parts).lower()

    def _tokenize_for_bm25(text: str) -> list[str]:
        raw = (text or "").strip().lower()
        if not raw:
            return []
        tokens: list[str] = []
        for tok in re.findall(r"[\u4e00-\u9fffA-Za-z0-9]+", raw):
            if len(tok) >= 2:
                tokens.append(tok)
            # 中文按 2-gram 切分，兼顾“千里浩瀚”这种词面匹配
            if re.search(r"[\u4e00-\u9fff]", tok) and len(tok) >= 2:
                tokens.extend(tok[i : i + 2] for i in range(0, len(tok) - 1))
        return tokens[:256]

    def _keyword_terms(q: str) -> list[str]:
        raw = (q or "").strip().lower()
        if len(raw) < 2:
            return []
        terms: list[str] = []
        for tok in re.findall(r"[\u4e00-\u9fffA-Za-z0-9]+", raw):
            if len(tok) >= 2:
                terms.append(tok)
            # 中文长串补充 4-gram，提升“吉利千里浩瀚技术”这类复合词召回
            if re.search(r"[\u4e00-\u9fff]", tok) and len(tok) >= 5:
                for i in range(0, len(tok) - 3):
                    gram = tok[i : i + 4]
                    if len(gram) >= 2:
                        terms.append(gram)
        # 去重并按长度降序，优先完整词
        uniq = sorted(set(t for t in terms if len(t) >= 2), key=len, reverse=True)
        return uniq[:12]

    def _env_bool(name: str, default: bool) -> bool:
        raw = os.getenv(name, "1" if default else "0").strip().lower()
        return raw not in ("0", "false", "no", "off")

    def _env_float(name: str, default: float) -> float:
        raw = os.getenv(name, str(default)).strip()
        try:
            return float(raw)
        except Exception:
            return default

    def _hybrid_rerank_enabled() -> bool:
        return _env_bool("KB_HYBRID_RERANK", True)

    def _hybrid_rerank_rows(rows: list[dict[str, Any]], q: str) -> list[dict[str, Any]]:
        if not rows or len(rows) < 2:
            return rows
        q_tokens = _tokenize_for_bm25(q)
        if not q_tokens:
            return rows

        vec_w = max(0.0, _env_float("KB_HYBRID_VEC_WEIGHT", 0.65))
        bm25_w = max(0.0, _env_float("KB_HYBRID_BM25_WEIGHT", 0.35))
        if vec_w <= 0 and bm25_w <= 0:
            return rows
        total_w = vec_w + bm25_w
        vec_w, bm25_w = vec_w / total_w, bm25_w / total_w

        docs_tokens: list[list[str]] = [_tokenize_for_bm25(_to_text(r)) for r in rows]
        doc_lens = [len(toks) for toks in docs_tokens]
        avgdl = (sum(doc_lens) / len(doc_lens)) if doc_lens else 1.0
        avgdl = max(avgdl, 1.0)

        # BM25 预计算
        df: dict[str, int] = {}
        for toks in docs_tokens:
            for t in set(toks):
                df[t] = df.get(t, 0) + 1
        n_docs = max(len(rows), 1)
        idf = {
            t: math.log(1.0 + (n_docs - d + 0.5) / (d + 0.5))
            for t, d in df.items()
        }

        k1 = 1.2
        b = 0.75
        bm25_scores: list[float] = []
        for toks in docs_tokens:
            tf: dict[str, int] = {}
            for t in toks:
                tf[t] = tf.get(t, 0) + 1
            dl = max(len(toks), 1)
            s = 0.0
            for qt in q_tokens:
                f = tf.get(qt, 0)
                if f <= 0:
                    continue
                denom = f + k1 * (1 - b + b * dl / avgdl)
                s += idf.get(qt, 0.0) * ((f * (k1 + 1)) / max(denom, 1e-9))
            bm25_scores.append(s)

        max_bm25 = max(bm25_scores) if bm25_scores else 0.0
        if max_bm25 <= 0:
            return rows

        scored: list[tuple[dict[str, Any], float, float, float]] = []
        for row, bm25 in zip(rows, bm25_scores):
            dist = row.get("distance")
            sem = 0.0
            if isinstance(dist, (int, float)):
                sem = max(0.0, min(1.0, 1.0 - float(dist)))
            bm = max(0.0, min(1.0, bm25 / max_bm25))
            hybrid = vec_w * sem + bm25_w * bm
            scored.append((row, hybrid, sem, bm))

        scored.sort(key=lambda x: x[1], reverse=True)
        reranked: list[dict[str, Any]] = []
        for row, hybrid, _sem, _bm in scored:
            nr = dict(row)
            nr["distance"] = 1.0 - hybrid
            reranked.append(nr)
        return reranked

    def _has_lexical_hit(rows: list[dict[str, Any]], q: str) -> bool:
        terms = _keyword_terms(q)
        if not terms:
            return False
        for r in rows:
            txt = _to_text(r)
            if any(t in txt for t in terms):
                return True
        return False

    def _precision_fallback_enabled() -> bool:
        raw = os.getenv("KB_QUERY_CROSS_COLLECTION_FALLBACK", "1").strip().lower()
        return raw not in ("0", "false", "no", "off")

    result = await kb_proxy_service.query_collection(
        collection_name=resolved_name,
        query_text=query,
        n_results=limit,
        project_id=project_id,
    )
    filtered = _filter_project_kb_results(result, resolved_name)
    if _hybrid_rerank_enabled():
        before_rows = list(filtered.get("results") or [])
        after_rows = _hybrid_rerank_rows(before_rows, query)
        if after_rows:
            filtered["results"] = after_rows[:limit]
            filtered["count"] = min(len(after_rows), limit)
            if before_rows and after_rows and before_rows[0] != after_rows[0]:
                filtered["warning"] = merge_kb_warnings(
                    filtered.get("warning"),
                    "hybrid_rerank_applied",
                )
                logger.info(
                    "kb_query hybrid rerank query=%r resolved=%s",
                    query,
                    resolved_name,
                )

    # 精准词兜底：当前集合语义命中但词面不匹配时，跨集合再查一次，减少“命中但不相关”。
    rows = list(filtered.get("results") or [])
    if (
        _precision_fallback_enabled()
        and query.strip()
        and rows
        and not _has_lexical_hit(rows, query)
    ):
        cross = await kb_proxy_service.query_all_collections(
            query_text=query,
            n_results=max(limit * 3, limit),
            project_id=project_id,
            collection=None,
        )
        cross_rows = list(cross.get("results") or [])
        terms = _keyword_terms(query)
        lexical_rows = [
            r for r in cross_rows if any(t in _to_text(r) for t in terms)
        ]
        if lexical_rows:
            logger.info(
                "kb_query precision fallback triggered query=%r resolved=%s cross_hits=%d",
                query,
                resolved_name,
                len(lexical_rows),
            )
            merged_warning = merge_kb_warnings(
                filtered.get("warning"),
                "semantic_miss_switched_to_cross_collection_lexical",
            )
            return {
                "results": lexical_rows[:limit],
                "source": cross.get("source", filtered.get("source", "chroma")),
                "count": min(len(lexical_rows), limit),
                "warning": merge_kb_warnings(merged_warning, resolve_warning),
                "collection_resolved": resolved_name,
                "fallback_scope": "__all__",
            }

    filtered["warning"] = merge_kb_warnings(filtered.get("warning"), resolve_warning)
    if resolved_name != str(collection_name or "").strip():
        filtered["collection_resolved"] = resolved_name
    await _record_kb_miss_if_empty(
        filtered,
        query=query,
        collection=resolved_name,
        project_id=project_id,
    )
    return filtered


async def kb_list_collections(project_id: Optional[str] = None) -> dict:
    """
    List all available knowledge base collections.

    Args:
        project_id: Optional project ID to filter collections

    Returns:
        {
            "collections": [str, ...],
            "source": "chroma" | "cache",
            "warning": Optional[str]
        }
    """
    return await kb_proxy_service.list_collections(project_id=project_id)


async def kb_get_entry(
    collection_name: str,
    entry_id: str,
    project_id: str,
) -> dict:
    """
    Retrieve a specific knowledge base entry by ID.

    Args:
        collection_name: Collection name to search within
        entry_id: The entry ID to retrieve
        project_id: Project ID for cache scope

    Returns:
        Entry dict with id, content, metadata, source, reliability, etc.
        Returns empty dict if not found.
    """
    entries = await kb_cache_service.get_cached_entries(
        project_id=project_id,
        collection=collection_name,
        limit=1000,
    )
    for entry in entries:
        if entry.get("id") == entry_id:
            return entry
    return {}


async def kb_add_entry(
    collection_name: str,
    project_id: str,
    title: str,
    content: str,
    summary: str = "",
    tags: Optional[list[str]] = None,
    domain: str = "internal_methodology",
    source: str = "hermes_chat",
    published: bool = False,
    metadata: Optional[dict[str, Any]] = None,
    scenario_id: Optional[str] = None,
) -> dict:
    """
    将对话中已确认的摘录写入知识库（默认草稿 unpublished）。

    禁止在未取得用户明确同意时调用。须先展示草稿并请用户确认「是否存入知识库」。
    """
    return await add_kb_harvest_entry(
        collection_name=collection_name,
        project_id=project_id,
        title=title,
        content=content,
        summary=summary or None,
        tags=tags,
        domain=domain,
        source=source,
        published=published,
        metadata=metadata,
        scenario_id=scenario_id,
        strict_domain=False,
    )
