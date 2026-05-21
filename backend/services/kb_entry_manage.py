"""
知识库条目增删改：Chroma 写入 + kb_cache 同步/清理。
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from sqlalchemy import delete, or_, select

from backend.db import async_session_maker
from backend.models.kb_cache import KBCache
from backend.services.chroma_client import ChromaHttpClient, flatten_chroma_get_ids
from backend.services.kb_cache import kb_cache_service
from backend.services.kb_contract import KB_DOMAIN_ENUM
from backend.services.kb_ingest_core import (
    build_manifest_from_harvest,
    new_ingest_job_id,
    run_kb_ingestion,
)
from backend.services.kb_metadata import normalize_kb_metadata_dict
from backend.services.kb_proxy import CHROMA_HOST
from backend.services.kb_write import build_markdown_body, kb_upload_root
from backend.services.project_kb_ingest import delete_doc_from_collection

log = logging.getLogger("tpdx.hermes")


def _iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S%z")


def _flatten_metas(data: dict[str, Any]) -> list[dict[str, Any]]:
    metas = data.get("metadatas") or []
    if metas and isinstance(metas[0], list):
        return [m if isinstance(m, dict) else {} for m in metas[0]]
    if isinstance(metas, list):
        return [m if isinstance(m, dict) else {} for m in metas]
    return []


def _flatten_docs(data: dict[str, Any]) -> list[str]:
    docs = data.get("documents") or []
    if docs and isinstance(docs[0], list):
        return [str(d) if d is not None else "" for d in docs[0]]
    if isinstance(docs, list):
        return [str(d) if d is not None else "" for d in docs]
    return []


def _get_doc_chunks(
    client: ChromaHttpClient,
    collection: str,
    doc_id: str,
) -> tuple[list[str], list[dict[str, Any]], list[str]]:
    data = client.get_by_where(
        collection,
        {"doc_id": doc_id},
        limit=100_000,
        include=["metadatas", "documents"],
    )
    ids = flatten_chroma_get_ids(data)
    metas = _flatten_metas(data)
    docs = _flatten_docs(data)
    return ids, metas, docs


def _validate_domain(domain: str | None, strict: bool) -> str | None:
    if not domain:
        return None
    dom = domain.strip()
    if strict and dom and dom not in KB_DOMAIN_ENUM:
        return f"unknown_domain:{dom}"
    return None


async def _sync_cache(
    *,
    chroma_url: str,
    project_id: str,
    collection: str,
) -> dict[str, Any] | None:
    try:
        return await kb_cache_service.sync_from_external(
            external_kb_url=chroma_url,
            project_id=project_id,
            collections=[collection],
        )
    except Exception as e:
        log.warning("kb_entry_manage cache sync failed collection=%s: %s", collection, e)
        return {"error": str(e)}


async def delete_cached_entries_by_doc_id(
    doc_id: str,
    collection: str | None = None,
) -> int:
    """从本地 kb_cache 移除 doc_id 对应 chunk（Chroma 删除后即时清理）。"""
    await kb_cache_service.ensure_table()
    prefix = f"{doc_id}_chunk_"
    removed = 0
    async with async_session_maker() as db:
        query = select(KBCache).where(
            or_(
                KBCache.id == doc_id,
                KBCache.id.like(f"{prefix}%"),
            )
        )
        if collection:
            query = query.where(KBCache.collection == collection)
        rows = (await db.execute(query)).scalars().all()
        extra_ids: list[str] = []
        if rows:
            ids_to_delete = {r.id for r in rows}
        else:
            ids_to_delete = set()
        # metadata.doc_id 匹配（兼容非标准 id）
        scan_q = select(KBCache)
        if collection:
            scan_q = scan_q.where(KBCache.collection == collection)
        scan_q = scan_q.limit(8000)
        for row in (await db.execute(scan_q)).scalars().all():
            if row.id in ids_to_delete:
                continue
            try:
                meta = normalize_kb_metadata_dict(json.loads(row.metadata_ or "{}"))
            except json.JSONDecodeError:
                meta = {}
            if str(meta.get("doc_id") or "") == doc_id:
                extra_ids.append(row.id)
        all_ids = list(ids_to_delete | set(extra_ids))
        if not all_ids:
            return 0
        await db.execute(delete(KBCache).where(KBCache.id.in_(all_ids)))
        await db.commit()
        removed = len(all_ids)
    log.info("kb_cache purge doc_id=%s removed=%s collection=%s", doc_id, removed, collection)
    return removed


async def delete_cached_entries_by_collection(collection: str) -> int:
    """从 kb_cache 移除指定 collection 的全部条目。"""
    await kb_cache_service.ensure_table()
    col = collection.strip()
    if not col:
        return 0
    async with async_session_maker() as db:
        result = await db.execute(delete(KBCache).where(KBCache.collection == col))
        await db.commit()
        removed = int(result.rowcount or 0)
    log.info("kb_cache purge collection=%s removed=%s", col, removed)
    return removed


def _delete_collection_sync(*, collection: str, chroma_url: str) -> dict[str, Any]:
    client = ChromaHttpClient(chroma_url)
    if not client.heartbeat():
        return {"ok": False, "message": "kb_unavailable"}
    col = collection.strip()
    try:
        all_ids = client.list_all_ids(col)
    except Exception as e:
        log.exception("delete_collection list ids failed collection=%s", col)
        return {"ok": False, "message": str(e)}
    if not all_ids:
        return {"ok": True, "collection": col, "removed_chunks": 0, "removed_docs": 0}
    for i in range(0, len(all_ids), 500):
        client.delete(col, all_ids[i : i + 500])
    return {
        "ok": True,
        "collection": col,
        "removed_chunks": len(all_ids),
    }


def _update_kb_entry_sync(
    *,
    collection: str,
    doc_id: str,
    chroma_url: str,
    title: str | None = None,
    content: str | None = None,
    metadata: dict[str, Any] | None = None,
    strict_domain: bool = False,
) -> dict[str, Any]:
    client = ChromaHttpClient(chroma_url)
    if not client.heartbeat():
        return {"ok": False, "message": "kb_unavailable"}

    meta_patch = dict(metadata or {})
    dom_err = _validate_domain(meta_patch.get("domain"), strict_domain)
    if dom_err:
        return {"ok": False, "message": dom_err}

    if content is not None and content.strip():
        title_val = (title or meta_patch.get("title") or doc_id).strip()
        body = build_markdown_body(title_val, meta_patch.get("summary"), content)
        base = kb_upload_root() / "manual_edit"
        base.mkdir(parents=True, exist_ok=True)
        path = base / f"{doc_id}.md"
        path.write_text(body, encoding="utf-8")

        ids_existing, metas_existing, _ = _get_doc_chunks(client, collection, doc_id)
        defaults: dict[str, Any] = {}
        if metas_existing:
            defaults = normalize_kb_metadata_dict(dict(metas_existing[0]))
        defaults.update({k: v for k, v in meta_patch.items() if v is not None})
        defaults["source_type"] = defaults.get("source_type") or "manual"
        defaults["source"] = defaults.get("source") or "kb_manage"
        if title_val:
            defaults["title"] = title_val

        batch_id = new_ingest_job_id()
        manifest = build_manifest_from_harvest(
            batch_id=batch_id,
            collection=collection,
            doc_id=doc_id,
            file_path=str(path),
            title=title_val,
            defaults=defaults,
        )
        report = run_kb_ingestion(
            manifest=manifest,
            collection=collection,
            chroma_url=chroma_url,
            job_id=batch_id,
            dry_run=False,
            strict_domain=strict_domain,
        )
        if (report.get("doc_succeeded") or 0) < 1:
            err = (report.get("errors") or [{}])[0]
            return {"ok": False, "message": str(err.get("error", "ingest_failed")), "report": report}
        return {
            "ok": True,
            "doc_id": doc_id,
            "updated": "content",
            "chunk_count": int(report.get("chunk_upserted") or 0),
            "report": report,
        }

    ids, metas, _ = _get_doc_chunks(client, collection, doc_id)
    if not ids:
        return {"ok": False, "message": "entry_not_found", "doc_id": doc_id}

    new_title = title.strip() if title and title.strip() else None
    updated_ids: list[str] = []
    for cid, raw_meta in zip(ids, metas):
        merged = normalize_kb_metadata_dict(dict(raw_meta))
        if new_title:
            merged["title"] = new_title
        for k, v in meta_patch.items():
            if v is not None:
                merged[k] = v
        merged["updated_at"] = _iso_now()
        client.update(collection, [cid], [merged])
        updated_ids.append(cid)

    return {
        "ok": True,
        "doc_id": doc_id,
        "updated": "metadata",
        "chunk_ids": updated_ids,
        "chunk_count": len(updated_ids),
    }


async def update_kb_entry(
    *,
    collection: str,
    doc_id: str,
    project_id: str = "__all__",
    chroma_url: str | None = None,
    title: str | None = None,
    content: str | None = None,
    metadata: dict[str, Any] | None = None,
    strict_domain: bool = False,
    sync_cache: bool = True,
) -> dict[str, Any]:
    chroma = (chroma_url or CHROMA_HOST).strip()
    result = await asyncio.to_thread(
        _update_kb_entry_sync,
        collection=collection.strip(),
        doc_id=doc_id.strip(),
        chroma_url=chroma,
        title=title,
        content=content,
        metadata=metadata,
        strict_domain=strict_domain,
    )
    if not result.get("ok"):
        return result
    cache_detail = None
    if sync_cache:
        cache_detail = await _sync_cache(
            chroma_url=chroma,
            project_id=project_id.strip() or "__all__",
            collection=collection.strip(),
        )
    result["cache_synced"] = bool(sync_cache)
    if cache_detail is not None:
        result["cache_sync_detail"] = cache_detail
    return result


async def delete_kb_entry(
    *,
    collection: str,
    doc_id: str,
    project_id: str = "__all__",
    chroma_url: str | None = None,
    sync_cache: bool = True,
) -> dict[str, Any]:
    chroma = (chroma_url or CHROMA_HOST).strip()
    col = collection.strip()
    did = doc_id.strip()

    def _delete_sync() -> dict[str, Any]:
        client = ChromaHttpClient(chroma)
        if not client.heartbeat():
            return {"ok": False, "message": "kb_unavailable"}
        removed = delete_doc_from_collection(col, did, chroma)
        if removed <= 0:
            return {"ok": False, "message": "entry_not_found", "doc_id": did, "removed_chunks": 0}
        return {"ok": True, "doc_id": did, "removed_chunks": removed}

    result = await asyncio.to_thread(_delete_sync)
    if not result.get("ok"):
        return result

    cache_removed = await delete_cached_entries_by_doc_id(did, collection=col)
    result["cache_removed"] = cache_removed

    if sync_cache:
        cache_detail = await _sync_cache(
            chroma_url=chroma,
            project_id=project_id.strip() or "__all__",
            collection=col,
        )
        result["cache_synced"] = True
        if cache_detail is not None:
            result["cache_sync_detail"] = cache_detail
    else:
        result["cache_synced"] = False
    return result


async def delete_kb_collection(
    *,
    collection: str,
    project_id: str = "__all__",
    chroma_url: str | None = None,
    sync_cache: bool = True,
) -> dict[str, Any]:
    """删除 Chroma collection 内全部 chunk，并清理 kb_cache 中该 collection。"""
    chroma = (chroma_url or CHROMA_HOST).strip()
    col = collection.strip()
    result = await asyncio.to_thread(
        _delete_collection_sync,
        collection=col,
        chroma_url=chroma,
    )
    if not result.get("ok"):
        return result
    cache_removed = await delete_cached_entries_by_collection(col)
    result["cache_removed"] = cache_removed
    if sync_cache and (result.get("removed_chunks") or 0) > 0:
        cache_detail = await _sync_cache(
            chroma_url=chroma,
            project_id=project_id.strip() or "__all__",
            collection=col,
        )
        result["cache_synced"] = True
        if cache_detail is not None:
            result["cache_sync_detail"] = cache_detail
    else:
        result["cache_synced"] = False
    return result


def _create_manual_entry_sync(
    *,
    collection: str,
    title: str,
    content: str,
    domain: str,
    folder_path: str,
    published: bool,
    doc_id: str | None,
    source_type: str,
    chroma_url: str,
    strict_domain: bool,
) -> dict[str, Any]:
    client = ChromaHttpClient(chroma_url)
    if not client.heartbeat():
        return {"ok": False, "message": "kb_unavailable"}

    dom = (domain or "structured_tech").strip()
    dom_err = _validate_domain(dom, strict_domain)
    if dom_err:
        return {"ok": False, "message": dom_err}

    norm_content = content.strip()
    if not title.strip() or not norm_content:
        return {"ok": False, "message": "title_and_content_required"}

    did = (doc_id or "").strip() or f"manual_{uuid.uuid4().hex[:12]}"
    base = kb_upload_root() / "manual"
    base.mkdir(parents=True, exist_ok=True)
    path = base / f"{did}.md"
    path.write_text(build_markdown_body(title.strip(), None, norm_content), encoding="utf-8")

    batch_id = new_ingest_job_id()
    defaults: dict[str, Any] = {
        "domain": dom,
        "folder_path": (folder_path or "02-知识库/手动录入").strip(),
        "source": "kb_manage",
        "source_type": source_type or "manual",
        "published": bool(published),
    }
    manifest = build_manifest_from_harvest(
        batch_id=batch_id,
        collection=collection,
        doc_id=did,
        file_path=str(path),
        title=title.strip(),
        defaults=defaults,
    )
    report = run_kb_ingestion(
        manifest=manifest,
        collection=collection,
        chroma_url=chroma_url,
        job_id=batch_id,
        dry_run=False,
        strict_domain=strict_domain,
    )
    if (report.get("doc_succeeded") or 0) < 1:
        err = (report.get("errors") or [{}])[0]
        return {"ok": False, "message": str(err.get("error", "ingest_failed")), "report": report}

    chunk_count = int(report.get("chunk_upserted") or 0)
    entry_id = f"{did}_chunk_0001" if chunk_count else did
    return {
        "ok": True,
        "doc_id": did,
        "entry_id": entry_id,
        "chunk_count": chunk_count,
        "collection": collection,
        "report": report,
    }


async def create_kb_manual_entry(
    *,
    collection: str,
    title: str,
    content: str,
    domain: str = "structured_tech",
    folder_path: str = "02-知识库/手动录入",
    published: bool = True,
    doc_id: str | None = None,
    source_type: str = "manual",
    project_id: str = "__all__",
    chroma_url: str | None = None,
    strict_domain: bool = False,
    sync_cache: bool = True,
) -> dict[str, Any]:
    chroma = (chroma_url or CHROMA_HOST).strip()
    result = await asyncio.to_thread(
        _create_manual_entry_sync,
        collection=collection.strip(),
        title=title,
        content=content,
        domain=domain,
        folder_path=folder_path,
        published=published,
        doc_id=doc_id,
        source_type=source_type,
        chroma_url=chroma,
        strict_domain=strict_domain,
    )
    if not result.get("ok"):
        return result
    if sync_cache:
        cache_detail = await _sync_cache(
            chroma_url=chroma,
            project_id=project_id.strip() or "__all__",
            collection=collection.strip(),
        )
        result["cache_synced"] = True
        if cache_detail is not None:
            result["cache_sync_detail"] = cache_detail
    else:
        result["cache_synced"] = False
    return result
