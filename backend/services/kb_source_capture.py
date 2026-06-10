"""KB 检索来源按 run_id 跨进程落库，供聊天回复溯源标记。"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import async_session_maker
from backend.models.orchestration_run import OrchestrationRun

logger = logging.getLogger("tpdx.hermes")

_CITATION_REF_RE = re.compile(r"\[\^(\d+)\]")
_EXCERPT_MAX = 200


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
    }


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
) -> None:
    """编排开始前预检索并捕获来源，避免 Agent 未传 tphermes_run_id 时无溯源数据。"""
    cols = [c.strip() for c in collections if c and str(c).strip()]
    q = (query_text or "").strip()[:400]
    if not q:
        return
    from backend.tools.kb_tools import kb_query

    for col in cols[:3]:
        try:
            result = await kb_query(
                q,
                col,
                limit=5,
                project_id=project_id,
                tphermes_run_id=run_id,
            )
            logger.info(
                "kb prefetch run_id=%s collection=%s count=%s",
                run_id,
                col,
                result.get("count", 0),
            )
        except Exception as exc:
            logger.warning(
                "kb prefetch failed run_id=%s collection=%s err=%s",
                run_id,
                col,
                exc,
            )

    async with async_session_maker() as db:
        existing = await load_kb_sources(db, run_id)
    if existing and (existing.get("sources") or []):
        return

    try:
        from backend.services.kb_proxy import kb_proxy_service

        cross = await kb_proxy_service.query_all_collections(
            query_text=q,
            n_results=5,
            project_id=project_id,
            collection=None,
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
    except Exception as exc:
        logger.warning("kb prefetch cross-collection failed run_id=%s err=%s", run_id, exc)


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
