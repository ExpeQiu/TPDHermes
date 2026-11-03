"""
知识库导入任务服务：负责请求归一化、任务入队、后台执行。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime, timedelta
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select, update

from backend.db import async_session_maker
from backend.models.kb_ingest_job import KbIngestJob
from backend.models.kb_source_file import KbSourceFile
from backend.services.kb_cache import kb_cache_service
from backend.services.kb_ingest_core import (
    build_manifest_from_uploads,
    new_ingest_job_id,
    run_kb_ingestion,
)
from backend.services.kb_access import assert_ingest_file, reject_client_chroma_url
from backend.services.kb_proxy import CHROMA_HOST

LEASE_SECONDS = int(os.getenv("KB_INGEST_LEASE_SECONDS", "900"))

log = logging.getLogger("tpdx.hermes.kb_ingest_jobs")


def _now_iso() -> str:
    return datetime.now().isoformat()


async def normalize_ingest_request(payload: dict[str, Any]) -> dict[str, Any]:
    source_type = str(payload.get("source_type") or "").strip()
    collection = str(payload.get("collection") or "").strip()
    project_id = str(payload.get("project_id") or "__all__").strip() or "__all__"
    chroma_url = reject_client_chroma_url(payload.get("chroma_url"))
    strict_domain = bool(payload.get("strict_domain", False))
    sync_cache = bool(payload.get("sync_cache", True))
    batch_chunk_size = int(payload.get("batch_chunk_size") or 64)

    if not collection:
        raise HTTPException(status_code=400, detail="collection 不能为空")
    if source_type not in {"manifest", "upload"}:
        raise HTTPException(status_code=400, detail="source_type 必须是 manifest 或 upload")

    manifest: dict[str, Any]
    normalized_payload = dict(payload)

    if source_type == "manifest":
        raw_manifest = payload.get("manifest")
        if not isinstance(raw_manifest, dict) or not raw_manifest:
            raise HTTPException(status_code=400, detail="manifest 模式需提供 manifest")
        manifest = dict(raw_manifest)
        manifest["collection"] = collection
    else:
        raw_upload_ids = payload.get("upload_ids")
        if not isinstance(raw_upload_ids, list) or not raw_upload_ids:
            raise HTTPException(status_code=400, detail="upload 模式需提供 upload_ids")
        upload_ids = [str(x).strip() for x in raw_upload_ids if str(x).strip()]
        if not upload_ids:
            raise HTTPException(status_code=400, detail="upload_ids 不能为空")

        async with async_session_maker() as db:
            rows = (
                await db.execute(select(KbSourceFile).where(KbSourceFile.id.in_(upload_ids)))
            ).scalars().all()
        by_id = {str(r.id): r for r in rows}
        missing = [uid for uid in upload_ids if uid not in by_id]
        if missing:
            raise HTTPException(status_code=400, detail=f"upload_ids 不存在: {missing}")
        actor = str(payload.get("created_by") or "").strip()
        for row in rows:
            owner = str(getattr(row, "created_by", "") or "").strip()
            if actor and owner and owner != actor:
                raise HTTPException(status_code=404, detail="upload 不存在")

        raw_override = payload.get("upload_doc_ids")
        upload_doc_ids = raw_override if isinstance(raw_override, dict) else {}
        defaults = dict(payload.get("defaults") or {})
        batch_id = str(defaults.get("import_batch") or new_ingest_job_id())
        items: list[dict[str, Any]] = []
        for uid in upload_ids:
            row = by_id[uid]
            doc_id = str(upload_doc_ids.get(uid) or "").strip() or (row.doc_id_hint or "").strip() or None
            items.append(
                {
                    "upload_id": row.id,
                    "stored_path": row.stored_path,
                    "file_name": row.file_name,
                    "checksum": row.checksum,
                    "doc_id": doc_id,
                    "doc_id_hint": row.doc_id_hint,
                }
            )
        manifest = build_manifest_from_uploads(batch_id, collection, defaults, items)
        normalized_payload["upload_ids"] = upload_ids

    documents = manifest.get("documents")
    if not isinstance(documents, list) or not documents:
        raise HTTPException(status_code=400, detail="manifest.documents 必须为非空数组")
    doc_ids = [str(doc.get("doc_id") or "").strip() for doc in documents if isinstance(doc, dict)]
    if not all(doc_ids):
        raise HTTPException(status_code=400, detail="documents 中存在空 doc_id")
    for doc in documents:
        if not isinstance(doc, dict):
            continue
        file_path = doc.get("file_path") or doc.get("stored_path")
        if not file_path:
            continue
        try:
            assert_ingest_file(str(file_path))
        except PermissionError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=400, detail=f"file_not_found:{exc}") from exc

    return {
        "payload": normalized_payload,
        "manifest": manifest,
        "collection": collection,
        "project_id": project_id,
        "chroma_url": chroma_url,
        "sync_cache": sync_cache,
        "strict_domain": strict_domain,
        "batch_chunk_size": batch_chunk_size,
        "doc_ids": doc_ids,
    }


async def create_ingest_job(
    *,
    normalized: dict[str, Any],
    created_by: str | None = None,
) -> dict[str, Any]:
    job_id = new_ingest_job_id()
    now = _now_iso()
    manifest = normalized["manifest"]
    row = KbIngestJob(
        id=job_id,
        source_type=str(normalized["payload"].get("source_type") or "manifest"),
        collection=str(manifest.get("collection") or normalized["collection"]),
        status="queued",
        payload_json=json.dumps(normalized["payload"], ensure_ascii=False),
        result_json=json.dumps(
            {
                "job_id": job_id,
                "status": "queued",
                "collection": str(manifest.get("collection") or normalized["collection"]),
                "doc_ids": normalized["doc_ids"],
            },
            ensure_ascii=False,
        ),
        created_at=now,
        updated_at=now,
        created_by=created_by,
        project_id=str(normalized.get("project_id") or ""),
        operation_id=job_id,
    )
    async with async_session_maker() as db:
        db.add(row)
        await db.commit()
    return {
        "job_id": job_id,
        "status": "queued",
        "collection": row.collection,
        "doc_ids": list(normalized["doc_ids"]),
        "created_at": now,
    }


async def get_ingest_job(job_id: str) -> dict[str, Any] | None:
    async with async_session_maker() as db:
        row = (
            await db.execute(select(KbIngestJob).where(KbIngestJob.id == job_id))
        ).scalar_one_or_none()
    if not row:
        return None
    return {
        "id": row.id,
        "source_type": row.source_type,
        "collection": row.collection,
        "status": row.status,
        "payload": json.loads(row.payload_json or "{}"),
        "result": json.loads(row.result_json) if row.result_json else None,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
        "created_by": row.created_by,
        "project_id": row.project_id,
        "worker_id": row.worker_id,
        "lease_until": row.lease_until,
        "error_message": row.error_message,
    }


async def queue_ingest_job(job_id: str) -> None:
    from backend.services.kb_ingest_worker import kb_ingest_worker

    await kb_ingest_worker.wakeup()
    log.info("kb_ingest queued job=%s", job_id)


async def claim_ingest_job(job_id: str, worker_id: str) -> KbIngestJob | None:
    """条件领取。第二个 worker 对同一 queued 任务更新行数为 0。"""
    now = datetime.now()
    lease = (now + timedelta(seconds=LEASE_SECONDS)).isoformat()
    now_s = now.isoformat()
    async with async_session_maker() as db:
        res = await db.execute(
            update(KbIngestJob)
            .where(KbIngestJob.id == job_id, KbIngestJob.status == "queued")
            .values(
                status="running",
                worker_id=worker_id,
                lease_until=lease,
                updated_at=now_s,
                error_message=None,
            )
        )
        await db.commit()
        if int(res.rowcount or 0) != 1:
            log.info("kb_ingest claim missed job=%s worker=%s", job_id, worker_id[:24])
            return None
        return await db.get(KbIngestJob, job_id)


async def process_ingest_job(job_id: str, worker_id: str = "worker") -> dict[str, Any] | None:
    row = await claim_ingest_job(job_id, worker_id)
    if row is None:
        return None

    payload = json.loads(row.payload_json or "{}")
    if row.created_by and not payload.get("created_by"):
        payload["created_by"] = row.created_by
    collection = str(payload.get("collection") or "")
    doc_ids: list[str] = []
    error_message = None
    try:
        normalized = await normalize_ingest_request(payload)
        manifest = normalized["manifest"]
        collection = str(manifest.get("collection") or normalized["collection"])
        doc_ids = list(normalized["doc_ids"])
        report = await asyncio.to_thread(
            run_kb_ingestion,
            manifest=manifest,
            collection=collection,
            chroma_url=normalized["chroma_url"],
            job_id=job_id,
            dry_run=False,
            batch_chunk_size=normalized["batch_chunk_size"],
            strict_domain=normalized["strict_domain"],
        )
        report["job_id"] = job_id
        report["doc_ids"] = doc_ids
        if normalized["sync_cache"]:
            sync_res = await kb_cache_service.sync_selection_from_external(
                external_kb_url=normalized["chroma_url"],
                project_id=normalized["project_id"],
                collection=collection,
                doc_ids=doc_ids,
            )
            report["cache_sync_triggered"] = True
            report["cache_sync_detail"] = sync_res
        else:
            report["cache_sync_triggered"] = False
        final_status = str(report.get("status") or "completed")
        if final_status != "failed":
            try:
                from backend.services.public_intel_ingest import graph_after_public_ingest

                kg_report = await graph_after_public_ingest(collection, manifest)
                if not kg_report.get("skipped"):
                    report["kg"] = kg_report
            except Exception as kg_exc:
                log.exception("kb_ingest graph hook failed job=%s collection=%s", job_id, collection)
                report["kg"] = {"ok": False, "error": str(kg_exc)}
                if final_status == "completed":
                    final_status = "partial"
                    report["status"] = "partial"
    except Exception as e:
        log.exception("kb_ingest failed job=%s", job_id)
        error_message = str(getattr(e, "detail", None) or e)
        report = {
            "job_id": job_id,
            "collection": collection,
            "status": "failed",
            "doc_ids": doc_ids,
            "errors": [{"doc": "", "error": error_message}],
            "cache_sync_triggered": False,
        }
        final_status = "failed"

    async with async_session_maker() as db:
        await db.execute(
            update(KbIngestJob)
            .where(KbIngestJob.id == job_id)
            .values(
                status=final_status,
                result_json=json.dumps(report, ensure_ascii=False),
                error_message=error_message,
                worker_id=None,
                lease_until=None,
                updated_at=_now_iso(),
            )
        )
        await db.commit()
    return report


async def requeue_running_ingest_jobs() -> int:
    """只重排租约已过期的 running。有效租约留给原 worker。"""
    now = _now_iso()
    async with async_session_maker() as db:
        rows = (
            await db.execute(select(KbIngestJob).where(KbIngestJob.status == "running"))
        ).scalars().all()
        expired = [
            row
            for row in rows
            if not row.lease_until or str(row.lease_until) <= now
        ]
        if not expired:
            return 0
        for row in expired:
            row.status = "queued"
            row.worker_id = None
            row.lease_until = None
            row.updated_at = now
            row.error_message = row.error_message or "lease_expired"
        await db.commit()
        log.info("kb_ingest requeued expired jobs=%s", len(expired))
        return len(expired)
