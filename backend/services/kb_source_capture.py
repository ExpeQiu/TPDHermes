"""KB 检索来源按 run_id 跨进程落库，供聊天回复溯源标记。"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Awaitable, Callable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import async_session_maker
from backend.models.orchestration_run import OrchestrationRun

logger = logging.getLogger("tpdx.hermes")

WEB_SOURCE_LABEL = "互联网"
WEB_TOOL_NAMES = frozenset({"tavily_search", "tavily_extract"})

_CITATION_REF_RE = re.compile(r"\[\^(\d+)\]")
_EXCERPT_MAX = 200
_PREFETCH_PROMPT_EXCERPT_MAX = 320
_KB_PREFETCH_MAX_COLLECTIONS = max(1, int(os.getenv("KB_PREFETCH_MAX_COLLECTIONS", "3")))
_KB_PREFETCH_COLLECTION_TIMEOUT_SEC = float(
    os.getenv("KB_PREFETCH_COLLECTION_TIMEOUT_SEC", "6")
)
_KB_PREFETCH_FALLBACK_TIMEOUT_SEC = float(
    os.getenv("KB_PREFETCH_FALLBACK_TIMEOUT_SEC", "8")
)


@dataclass(frozen=True)
class KbPrefetchResult:
    """KB 预检索结果，供注入 prompt 以减少 Agent 重复工具调用。"""

    source_count: int
    prompt_block: str
    query: str


def format_kb_prefetch_prompt_block(capture: dict[str, Any] | None, query: str) -> str:
    """将已捕获来源格式化为 system 注入块。"""
    if not capture:
        return ""
    sources = capture.get("sources") or []
    if not isinstance(sources, list) or not sources:
        return ""
    q = (query or "").strip()[:120]
    lines = [
        "[系统预检索结果] 以下为对用户问题已完成的 kb_query 预检索（query="
        + q
        + "）。优先据此回答并在句末标注 [^N]（N 为下方 ref）。"
        "勿对相同 query 重复调用 kb_query 或 kb_list_collections；"
        "仅当预检索明显不足或用户追问新方向时再补充检索。",
        "",
    ]
    for raw in sources[:12]:
        if not isinstance(raw, dict):
            continue
        ref = raw.get("ref")
        if not isinstance(ref, int):
            continue
        title = str(raw.get("title") or "").strip()[:120]
        col = str(raw.get("collection") or "").strip()
        excerpt = str(raw.get("excerpt") or "").strip()
        lines.append(f"[^{ref}] collection={col} title={title}")
        if excerpt:
            lines.append(f"  excerpt: {excerpt[:_PREFETCH_PROMPT_EXCERPT_MAX]}")
    return "\n".join(lines)


def _trim_excerpt(text: str | None, max_len: int = _EXCERPT_MAX) -> str:
    raw = (text or "").strip()
    if not raw:
        return ""
    if len(raw) <= max_len:
        return raw
    return raw[:max_len] + "…"


def _chunk_id_from_row(row: dict[str, Any]) -> str:
    meta = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
    for key in ("id", "chunk_id"):
        val = meta.get(key) if meta else None
        if isinstance(val, str) and val.strip():
            return val.strip()
    rid = row.get("id")
    if isinstance(rid, str) and rid.strip():
        return rid.strip()
    return ""


def _title_from_row(row: dict[str, Any], chunk_id: str) -> str:
    meta = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
    for key in ("title", "name"):
        val = meta.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()[:120]
    doc_id = meta.get("doc_id") if meta else None
    if isinstance(doc_id, str) and doc_id.strip():
        return doc_id.strip()[:120]
    return chunk_id[:80] or "未命名资料"


def _source_from_row(
    row: dict[str, Any],
    *,
    collection: str,
    tool: str,
) -> dict[str, Any] | None:
    chunk_id = _chunk_id_from_row(row)
    if not chunk_id:
        return None
    meta = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
    doc_id = meta.get("doc_id") if isinstance(meta.get("doc_id"), str) else None
    chunk_index = meta.get("chunk_index")
    chunk_count = meta.get("chunk_count")
    distance = row.get("distance")
    content = str(row.get("content") or "")
    return {
        "chunk_id": chunk_id,
        "doc_id": doc_id,
        "title": _title_from_row(row, chunk_id),
        "collection": collection or str(meta.get("collection") or ""),
        "excerpt": _trim_excerpt(content),
        "chunk_index": chunk_index if isinstance(chunk_index, int) else None,
        "chunk_count": chunk_count if isinstance(chunk_count, int) else None,
        "distance": float(distance) if isinstance(distance, (int, float)) else None,
        "tool": tool,
        "source_kind": "kb",
    }


def _web_chunk_id(url: str) -> str:
    import hashlib

    u = (url or "").strip()
    if not u:
        return ""
    if len(u) <= 240:
        return f"web:{u}"
    digest = hashlib.sha256(u.encode()).hexdigest()[:16]
    return f"web:{digest}"


def _web_source_from_row(row: dict[str, Any], *, tool: str) -> dict[str, Any] | None:
    url = str(row.get("url") or "").strip()
    if not url:
        return None
    title = str(row.get("title") or "").strip() or url
    content = str(row.get("content") or row.get("description") or row.get("raw_content") or "")
    return {
        "chunk_id": _web_chunk_id(url),
        "doc_id": None,
        "title": title[:120],
        "collection": WEB_SOURCE_LABEL,
        "excerpt": _trim_excerpt(content),
        "chunk_index": row.get("position") if isinstance(row.get("position"), int) else None,
        "chunk_count": None,
        "distance": row.get("score") if isinstance(row.get("score"), (int, float)) else None,
        "tool": tool,
        "source_kind": "web",
        "url": url,
    }


def extract_sources_from_tavily_payload(
    payload: dict[str, Any],
    *,
    tool: str,
) -> list[dict[str, Any]]:
    rows = payload.get("results") if isinstance(payload.get("results"), list) else []
    out: list[dict[str, Any]] = []
    for idx, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        if not row.get("url") and row.get("content"):
            continue
        nr = dict(row)
        if "position" not in nr:
            nr["position"] = idx + 1
        src = _web_source_from_row(nr, tool=tool)
        if src:
            out.append(src)
    return out


def extract_sources_from_kb_query_payload(
    payload: dict[str, Any],
    *,
    collection_name: str,
) -> list[dict[str, Any]]:
    rows = payload.get("results") if isinstance(payload.get("results"), list) else []
    out: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        src = _source_from_row(row, collection=collection_name, tool="kb_query")
        if src:
            out.append(src)
    return out


def extract_sources_from_kb_get_entry_payload(
    payload: dict[str, Any],
    *,
    collection_name: str,
) -> list[dict[str, Any]]:
    if not payload or not isinstance(payload, dict):
        return []
    row = dict(payload)
    if "content" not in row and "metadata" not in row:
        return []
    src = _source_from_row(row, collection=collection_name, tool="kb_get_entry")
    return [src] if src else []


def _merge_sources(existing: dict[str, Any] | None, new_items: list[dict[str, Any]]) -> dict[str, Any]:
    base = dict(existing or {})
    sources: list[dict[str, Any]] = list(base.get("sources") or [])
    by_chunk: dict[str, dict[str, Any]] = {
        str(s.get("chunk_id")): s for s in sources if isinstance(s, dict) and s.get("chunk_id")
    }
    next_ref = max((int(s.get("ref") or 0) for s in sources), default=0) + 1
    query_order = max((int(s.get("query_order") or 0) for s in sources), default=0) + 1

    for item in new_items:
        cid = str(item.get("chunk_id") or "")
        if not cid:
            continue
        if cid in by_chunk:
            continue
        merged = dict(item)
        merged["ref"] = next_ref
        merged["query_order"] = query_order
        sources.append(merged)
        by_chunk[cid] = merged
        next_ref += 1

    base["sources"] = sources
    base["updated_at"] = datetime.now().isoformat()
    return base


async def append_kb_sources(
    db: AsyncSession,
    *,
    run_id: str,
    tool_name: str,
    payload: dict[str, Any],
    collection_name: str = "",
) -> dict[str, Any]:
    row = await db.get(OrchestrationRun, run_id)
    if not row:
        logger.warning("kb source capture skipped: run not found run_id=%s", run_id)
        return {}

    if tool_name == "kb_get_entry":
        new_items = extract_sources_from_kb_get_entry_payload(
            payload, collection_name=collection_name
        )
    elif tool_name in WEB_TOOL_NAMES:
        new_items = extract_sources_from_tavily_payload(payload, tool=tool_name)
    else:
        new_items = extract_sources_from_kb_query_payload(
            payload, collection_name=collection_name
        )
    if not new_items:
        return {}

    existing = None
    if row.kb_source_capture_json:
        try:
            existing = json.loads(row.kb_source_capture_json)
            if not isinstance(existing, dict):
                existing = None
        except json.JSONDecodeError:
            existing = None

    merged = _merge_sources(existing, new_items)
    row.kb_source_capture_json = json.dumps(merged, ensure_ascii=False)
    row.updated_at = datetime.now().isoformat()
    await db.commit()

    refs = [s.get("ref") for s in merged.get("sources") or [] if s.get("ref") is not None]
    logger.info(
        "kb source capture saved run_id=%s tool=%s new=%s refs=%s",
        run_id,
        tool_name,
        len(new_items),
        refs,
    )
    return merged


async def _resolve_run_id_from_context(
    db: AsyncSession,
    *,
    run_id: str | None,
    project_id: str | None,
    entrypoint: str = "chat",
) -> str | None:
    rid = (run_id or "").strip()
    if rid:
        return rid

    pid = (project_id or "").strip()
    if not pid:
        logger.warning("kb source capture skipped: missing tphermes_run_id and project_id")
        return None

    cutoff = (datetime.now() - timedelta(minutes=30)).isoformat()
    q = await db.execute(
        select(OrchestrationRun)
        .where(
            OrchestrationRun.project_id == pid,
            OrchestrationRun.entrypoint == entrypoint,
            OrchestrationRun.status == "running",
            OrchestrationRun.created_at >= cutoff,
        )
        .order_by(OrchestrationRun.created_at.desc())
        .limit(5)
    )
    for row in q.scalars():
        logger.info(
            "kb source capture fallback run_id=%s project_id=%s entrypoint=%s",
            row.id,
            pid,
            entrypoint,
        )
        return row.id

    q_any = await db.execute(
        select(OrchestrationRun)
        .where(
            OrchestrationRun.entrypoint == entrypoint,
            OrchestrationRun.status == "running",
            OrchestrationRun.created_at >= cutoff,
        )
        .order_by(OrchestrationRun.created_at.desc())
        .limit(1)
    )
    row_any = q_any.scalar_one_or_none()
    if row_any:
        logger.info(
            "kb source capture fallback run_id=%s entrypoint=%s (no project match)",
            row_any.id,
            entrypoint,
        )
        return row_any.id

    logger.warning(
        "kb source capture skipped: no pending run project_id=%s entrypoint=%s",
        pid,
        entrypoint,
    )
    return None


async def prefetch_kb_sources_for_run(
    *,
    run_id: str,
    project_id: str | None,
    collections: list[str],
    query_text: str,
    progress_cb: Callable[[str, dict[str, Any] | None], Awaitable[None]] | None = None,
) -> KbPrefetchResult:
    """编排开始前预检索并捕获来源；返回可注入 prompt 的片段以减少 Agent 重复检索。"""
    cols = [c.strip() for c in collections if c and str(c).strip()][: _KB_PREFETCH_MAX_COLLECTIONS]
    q = (query_text or "").strip()[:400]
    if not q:
        return KbPrefetchResult(source_count=0, prompt_block="", query="")

    from backend.tools.kb_tools import kb_query

    async def _progress(phase: str, payload: dict[str, Any] | None = None) -> None:
        if not progress_cb:
            return
        try:
            await progress_cb(phase, payload or {})
        except Exception:
            logger.debug("kb prefetch progress callback skipped run_id=%s phase=%s", run_id, phase)

    async def _query_collection(col: str, index: int, total: int) -> None:
        await _progress(
            "kb_prefetch_querying",
            {
                "collection": col,
                "index": index,
                "total": total,
            },
        )
        try:
            result = await asyncio.wait_for(
                kb_query(
                    q,
                    col,
                    limit=5,
                    project_id=project_id,
                    tphermes_run_id=run_id,
                ),
                timeout=_KB_PREFETCH_COLLECTION_TIMEOUT_SEC,
            )
            logger.info(
                "kb prefetch run_id=%s collection=%s count=%s",
                run_id,
                col,
                result.get("count", 0),
            )
            await _progress(
                "kb_prefetch_query_complete",
                {
                    "collection": col,
                    "index": index,
                    "total": total,
                    "count": int(result.get("count", 0) or 0),
                },
            )
        except TimeoutError:
            logger.warning(
                "kb prefetch timeout run_id=%s collection=%s timeout=%s",
                run_id,
                col,
                _KB_PREFETCH_COLLECTION_TIMEOUT_SEC,
            )
            await _progress(
                "kb_prefetch_query_timeout",
                {
                    "collection": col,
                    "index": index,
                    "total": total,
                },
            )
        except Exception as exc:
            logger.warning(
                "kb prefetch failed run_id=%s collection=%s err=%s",
                run_id,
                col,
                exc,
            )
            await _progress(
                "kb_prefetch_query_failed",
                {
                    "collection": col,
                    "index": index,
                    "total": total,
                    "error": str(exc),
                },
            )

    if cols:
        await asyncio.gather(
            *[_query_collection(col, index + 1, len(cols)) for index, col in enumerate(cols)],
            return_exceptions=True,
        )

    async with async_session_maker() as db:
        existing = await load_kb_sources(db, run_id)
    if not (existing and (existing.get("sources") or [])):
        try:
            from backend.services.kb_proxy import kb_proxy_service
            await _progress("kb_prefetch_cross_collection", {"query": q})
            cross = await asyncio.wait_for(
                kb_proxy_service.query_all_collections(
                    query_text=q,
                    n_results=5,
                    project_id=project_id,
                    collection=None,
                ),
                timeout=_KB_PREFETCH_FALLBACK_TIMEOUT_SEC,
            )
            if int(cross.get("count") or 0) > 0:
                async with async_session_maker() as db:
                    await append_kb_sources(
                        db,
                        run_id=run_id,
                        tool_name="kb_query",
                        payload=cross,
                        collection_name="__all__",
                    )
                logger.info(
                    "kb prefetch cross-collection run_id=%s count=%s",
                    run_id,
                    cross.get("count", 0),
                )
            await _progress(
                "kb_prefetch_cross_collection_complete",
                {"count": int(cross.get("count") or 0)},
            )
        except TimeoutError:
            logger.warning(
                "kb prefetch cross-collection timeout run_id=%s timeout=%s",
                run_id,
                _KB_PREFETCH_FALLBACK_TIMEOUT_SEC,
            )
            await _progress("kb_prefetch_cross_collection_timeout", {})
        except Exception as exc:
            logger.warning("kb prefetch cross-collection failed run_id=%s err=%s", run_id, exc)
            await _progress("kb_prefetch_cross_collection_failed", {"error": str(exc)})

    async with async_session_maker() as db:
        final = await load_kb_sources(db, run_id)
    sources = (final or {}).get("sources") or []
    count = len(sources) if isinstance(sources, list) else 0
    block = format_kb_prefetch_prompt_block(final, q)
    return KbPrefetchResult(source_count=count, prompt_block=block, query=q)


async def save_kb_sources_for_run(
    *,
    run_id: str | None,
    project_id: str | None,
    tool_name: str,
    payload: dict[str, Any],
    collection_name: str = "",
    entrypoint: str = "chat",
) -> dict[str, Any]:
    async with async_session_maker() as db:
        resolved = await _resolve_run_id_from_context(
            db, run_id=run_id, project_id=project_id, entrypoint=entrypoint
        )
        if not resolved:
            return {}
        return await append_kb_sources(
            db,
            run_id=resolved,
            tool_name=tool_name,
            payload=payload,
            collection_name=collection_name,
        )


async def load_kb_sources(db: AsyncSession, run_id: str) -> dict[str, Any] | None:
    row = await db.get(OrchestrationRun, run_id)
    if not row or not row.kb_source_capture_json:
        return None
    try:
        data = json.loads(row.kb_source_capture_json)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def extract_citation_refs_from_text(text: str) -> list[int]:
    seen: set[int] = set()
    refs: list[int] = []
    for m in _CITATION_REF_RE.finditer(text or ""):
        try:
            n = int(m.group(1))
        except ValueError:
            continue
        if n not in seen:
            seen.add(n)
            refs.append(n)
    return refs


def build_sources_payload_from_capture(
    capture: dict[str, Any] | None,
    assistant_text: str,
) -> dict[str, Any]:
    sources_raw = list((capture or {}).get("sources") or [])
    sources: list[dict[str, Any]] = []
    known_refs: set[int] = set()
    for s in sources_raw:
        if not isinstance(s, dict):
            continue
        ref = s.get("ref")
        if not isinstance(ref, int):
            continue
        known_refs.add(ref)
        sources.append(
            {
                "ref": ref,
                "chunk_id": s.get("chunk_id"),
                "doc_id": s.get("doc_id"),
                "title": s.get("title") or "",
                "collection": s.get("collection") or "",
                "excerpt": s.get("excerpt") or "",
                "chunk_index": s.get("chunk_index"),
                "chunk_count": s.get("chunk_count"),
                "distance": s.get("distance"),
                "source_kind": s.get("source_kind") or "kb",
                "url": s.get("url"),
            }
        )
    sources.sort(key=lambda x: int(x.get("ref") or 0))

    cited = extract_citation_refs_from_text(assistant_text)
    unresolved = [r for r in cited if r not in known_refs]

    return {
        "sources": sources,
        "unresolved_refs": unresolved,
        "citations_count": len(sources),
    }


async def build_sources_for_sse(run_id: str, assistant_text: str) -> dict[str, Any]:
    async with async_session_maker() as db:
        capture = await load_kb_sources(db, run_id)
    payload = build_sources_payload_from_capture(capture, assistant_text)
    payload["run_id"] = run_id
    return payload


def annotate_results_with_capture(
    results: list[dict[str, Any]],
    capture: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    if not results:
        return results
    by_chunk: dict[str, int] = {}
    for s in (capture or {}).get("sources") or []:
        if not isinstance(s, dict):
            continue
        cid = str(s.get("chunk_id") or "")
        ref = s.get("ref")
        if cid and isinstance(ref, int):
            by_chunk[cid] = ref

    annotated: list[dict[str, Any]] = []
    for row in results:
        nr = dict(row)
        cid = _chunk_id_from_row(nr)
        if cid and cid in by_chunk:
            nr["ref"] = by_chunk[cid]
        annotated.append(nr)
    return annotated


def annotate_web_results_with_capture(
    results: list[dict[str, Any]],
    capture: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    if not results:
        return results
    by_url: dict[str, int] = {}
    for s in (capture or {}).get("sources") or []:
        if not isinstance(s, dict) or s.get("source_kind") != "web":
            continue
        url = str(s.get("url") or "")
        cid = str(s.get("chunk_id") or "")
        ref = s.get("ref")
        if url and isinstance(ref, int):
            by_url[url] = ref
        if cid and isinstance(ref, int):
            by_url[cid] = ref

    annotated: list[dict[str, Any]] = []
    for row in results:
        nr = dict(row)
        url = str(nr.get("url") or "").strip()
        cid = _web_chunk_id(url) if url else ""
        ref = by_url.get(url) or by_url.get(cid)
        if isinstance(ref, int):
            nr["ref"] = ref
        annotated.append(nr)
    return annotated


async def save_web_sources_for_run(
    *,
    run_id: str | None,
    project_id: str | None,
    tool_name: str,
    payload: dict[str, Any],
    entrypoint: str = "chat",
) -> dict[str, Any]:
    return await save_kb_sources_for_run(
        run_id=run_id,
        project_id=project_id,
        tool_name=tool_name,
        payload=payload,
        collection_name=WEB_SOURCE_LABEL,
        entrypoint=entrypoint,
    )
