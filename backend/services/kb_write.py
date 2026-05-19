"""
对话知识收割：写入临时 markdown → 组装 manifest → run_kb_ingestion → cache sync。
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import uuid
from pathlib import Path
from typing import Any, Optional

from backend.services.chroma_client import ChromaHttpClient, flatten_chroma_get_ids
from backend.services.kb_cache import kb_cache_service
from backend.services.kb_contract import KB_DOMAIN_ENUM
from backend.services.kb_ingest_core import (
    build_manifest_from_harvest,
    new_ingest_job_id,
    run_kb_ingestion,
)
from backend.services.kb_proxy import CHROMA_HOST
from backend.services.knowledge_policy import validate_harvest_collection

log = logging.getLogger("tpdx.hermes")


def kb_upload_root() -> Path:
    return Path(os.getenv("KB_UPLOAD_DIR", str(Path("./data/kb_uploads").resolve()))).resolve()


def _normalize_text(s: str) -> str:
    return "\n".join((s or "").split()).strip()


def compute_doc_id_from_content(content: str) -> str:
    norm = _normalize_text(content)
    hx = hashlib.sha256(norm.encode("utf-8")).hexdigest()[:16]
    return f"harvest_{hx}"


def compute_dedupe_key(title: str, content: str) -> str:
    norm = _normalize_text(f"{title}\n{content}")
    return hashlib.sha256(norm.encode("utf-8")).hexdigest()


def _find_duplicate_doc_id(
    client: ChromaHttpClient,
    collection: str,
    dedupe_key: str,
) -> Optional[str]:
    try:
        data = client.get_by_where(
            collection,
            {"dedupe_key": dedupe_key},
            limit=50,
            include=["metadatas"],
        )
    except Exception as e:
        log.debug("kb_write dedupe query failed collection=%s: %s", collection, e)
        return None
    ids = flatten_chroma_get_ids(data)
    if not ids:
        return None
    metas = data.get("metadatas") or []
    if metas and isinstance(metas[0], list):
        metas_list: list[Any] = metas[0]
    else:
        metas_list = metas if isinstance(metas, list) else []
    for m in metas_list:
        if not isinstance(m, dict):
            continue
        did = m.get("doc_id")
        if did:
            return str(did)
    return ids[0].rsplit("_chunk_", 1)[0] if "_chunk_" in ids[0] else None


def build_markdown_body(title: str, summary: Optional[str], content: str) -> str:
    parts = [f"# {title.strip()}"]
    if summary and summary.strip():
        parts.append("")
        parts.append(summary.strip())
        parts.append("")
    parts.append(content.strip())
    return "\n".join(parts) + "\n"


def _add_kb_harvest_entry_sync_inner(
    *,
    collection_name: str,
    project_id: str,
    title: str,
    content: str,
    summary: Optional[str] = None,
    tags: Optional[list[str]] = None,
    domain: str = "internal_methodology",
    source: str = "hermes_chat",
    published: bool = False,
    metadata: Optional[dict[str, Any]] = None,
    scenario_id: Optional[str] = None,
    chroma_url: Optional[str] = None,
    strict_domain: bool = False,
) -> dict[str, Any]:
    trace_id = str(uuid.uuid4())
    chroma = (chroma_url or CHROMA_HOST).strip()

    ok_pol, pol_err, allowed = validate_harvest_collection(
        collection_name,
        project_id=project_id,
        scenario_id=scenario_id,
    )
    if not ok_pol:
        log.info(
            "kb_harvest policy reject trace=%s collection=%s allowed=%s",
            trace_id,
            collection_name,
            allowed,
        )
        return {
            "ok": False,
            "readonly": False,
            "message": pol_err or "collection_not_allowed",
            "trace_id": trace_id,
            "allowed_collections": allowed,
        }

    dom = (domain or "internal_methodology").strip()
    if strict_domain and dom not in KB_DOMAIN_ENUM:
        return {
            "ok": False,
            "message": f"unknown_domain:{dom}",
            "trace_id": trace_id,
        }

    client = ChromaHttpClient(chroma)
    if not client.heartbeat():
        log.warning("kb_harvest chroma unreachable trace=%s url=%s", trace_id, chroma)
        return {
            "ok": False,
            "readonly": True,
            "message": "kb_unavailable",
            "trace_id": trace_id,
        }

    norm_content = _normalize_text(content)
    if not title.strip() or not norm_content:
        return {
            "ok": False,
            "message": "title_and_content_required",
            "trace_id": trace_id,
        }

    doc_id = compute_doc_id_from_content(content)
    dedupe_key = compute_dedupe_key(title, content)

    existing = _find_duplicate_doc_id(client, collection_name, dedupe_key)
    if existing:
        log.info(
            "kb_harvest duplicate trace=%s dedupe_key=%s existing=%s",
            trace_id,
            dedupe_key[:12],
            existing,
        )
        return {
            "ok": False,
            "reason": "duplicate",
            "existing_doc_id": existing,
            "message": "duplicate entry",
            "trace_id": trace_id,
        }

    base = kb_upload_root() / "harvest"
    base.mkdir(parents=True, exist_ok=True)
    path = base / f"{doc_id}.md"
    body = build_markdown_body(title, summary, content)
    path.write_text(body, encoding="utf-8")

    meta = dict(metadata or {})
    batch_id = new_ingest_job_id()
    job_id = batch_id

    project_ids_val: list[int] = []
    pid_raw = str(project_id).strip()
    if pid_raw and pid_raw not in ("__all__", "*", "all"):
        try:
            project_ids_val = [int(pid_raw)]
        except ValueError:
            pass

    defaults: dict[str, Any] = {
        "domain": dom,
        "folder_path": "conversation_harvest",
        "source": source,
        "source_type": "conversation_harvest",
        "published": bool(published),
        "tags": list(tags or []),
        "dedupe_key": dedupe_key,
        "harvested_from_user_confirmed": bool(meta.get("harvested_from_user_confirmed", True)),
        "trace_id": trace_id,
    }
    if project_ids_val:
        defaults["project_ids"] = project_ids_val
    if meta.get("conversation_id") is not None:
        defaults["conversation_id"] = str(meta["conversation_id"])
    if meta.get("message_ids") is not None:
        defaults["message_ids"] = meta["message_ids"]
    if meta.get("confidence") is not None:
        defaults["confidence"] = meta["confidence"]
    if meta.get("created_by") is not None:
        defaults["created_by"] = str(meta["created_by"])
    if scenario_id:
        defaults["scenario_id"] = str(scenario_id)

    manifest = build_manifest_from_harvest(
        batch_id=batch_id,
        collection=collection_name,
        doc_id=doc_id,
        file_path=str(path),
        title=title.strip(),
        defaults=defaults,
    )

    try:
        report = run_kb_ingestion(
            manifest=manifest,
            collection=collection_name,
            chroma_url=chroma,
            job_id=job_id,
            dry_run=False,
            strict_domain=strict_domain,
        )
    except Exception as e:
        log.exception("kb_harvest ingest failed trace=%s", trace_id)
        return {
            "ok": False,
            "message": str(e),
            "trace_id": trace_id,
        }

    if (report.get("doc_succeeded") or 0) < 1:
        err = (report.get("errors") or [{}])[0]
        return {
            "ok": False,
            "message": str(err.get("error", "ingest_failed")),
            "trace_id": trace_id,
            "report": report,
        }

    chunk_count = int(report.get("chunk_upserted") or 0)
    entry_id = f"{doc_id}_chunk_0001" if chunk_count else doc_id

    sync_project = pid_raw if pid_raw else "__all__"
    log.info(
        "kb_harvest ingest_done trace=%s doc_id=%s chunks=%s will_sync_project=%s",
        trace_id,
        doc_id,
        chunk_count,
        sync_project,
    )

    return {
        "ok": True,
        "message": "entry created",
        "entry_id": entry_id,
        "doc_id": doc_id,
        "collection_name": collection_name,
        "chunk_count": chunk_count,
        "published": bool(published),
        "trace_id": trace_id,
        "ingest_report": report,
        "_sync": {
            "chroma_url": chroma,
            "project_id": sync_project,
            "collections": [collection_name],
        },
    }


async def add_kb_harvest_entry(
    *,
    collection_name: str,
    project_id: str,
    title: str,
    content: str,
    summary: Optional[str] = None,
    tags: Optional[list[str]] = None,
    domain: str = "internal_methodology",
    source: str = "hermes_chat",
    published: bool = False,
    metadata: Optional[dict[str, Any]] = None,
    scenario_id: Optional[str] = None,
    chroma_url: Optional[str] = None,
    strict_domain: bool = False,
) -> dict[str, Any]:
    """异步入口：ingest 在线程池执行，cache 同步 await。"""
    result = await asyncio.to_thread(
        _add_kb_harvest_entry_sync_inner,
        collection_name=collection_name,
        project_id=project_id,
        title=title,
        content=content,
        summary=summary,
        tags=tags,
        domain=domain,
        source=source,
        published=published,
        metadata=metadata,
        scenario_id=scenario_id,
        chroma_url=chroma_url,
        strict_domain=strict_domain,
    )
    sync = result.pop("_sync", None)
    if result.get("ok") and sync:
        try:
            await kb_cache_service.sync_from_external(
                external_kb_url=str(sync["chroma_url"]),
                project_id=str(sync["project_id"]),
                collections=list(sync["collections"]),
            )
        except Exception as sync_e:
            log.warning("kb_harvest cache sync failed trace=%s: %s", result.get("trace_id"), sync_e)
    return result
