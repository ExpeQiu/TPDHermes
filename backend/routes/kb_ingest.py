"""
知识库导入 / 上传 / 发布 路由（与 kb.py 并列，prefix=/kb）。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import select

from backend.db import async_session_maker
from backend.models.kb_ingest_job import KbIngestJob
from backend.models.kb_source_file import KbSourceFile
from backend.services.chroma_client import ChromaHttpClient, flatten_chroma_get_ids
from backend.services.kb_cache import kb_cache_service
from backend.services.kb_ingest_core import (
    build_manifest_from_uploads,
    new_ingest_job_id,
    run_kb_ingestion,
    sha256_file,
)
from backend.services.kb_proxy import CHROMA_HOST

router = APIRouter(prefix="/kb", tags=["knowledge_base"])
log = logging.getLogger("tpdx.hermes")

KB_UPLOAD_DIR = os.getenv("KB_UPLOAD_DIR", str(Path("./data/kb_uploads").resolve()))


class KbIngestRequest(BaseModel):
    source_type: str = Field(..., description="manifest | upload")
    collection: str
    project_id: str = "__all__"
    sync_cache: bool = True
    chroma_url: Optional[str] = None
    strict_domain: bool = False
    manifest: Optional[dict[str, Any]] = None
    upload_ids: Optional[list[str]] = None
    upload_doc_ids: Optional[dict[str, str]] = Field(
        default=None,
        description="upload_id -> doc_id，覆盖上传记录中的默认 doc_id",
    )
    defaults: Optional[dict[str, Any]] = None
    batch_chunk_size: int = 64


class KbPublishRequest(BaseModel):
    collection: str
    doc_ids: list[str]
    published: bool = True
    project_id: str = "__all__"
    sync_cache: bool = True
    chroma_url: Optional[str] = None


def _flatten_get_ids(data: dict[str, Any]) -> list[str]:
    return flatten_chroma_get_ids(data)


@router.post("/upload")
async def kb_upload(
    file: UploadFile = File(...),
    doc_id: Optional[str] = Form(None),
):
    """multipart 上传，写入 KB_UPLOAD_DIR 并登记 kb_source_files。"""
    upload_id = str(uuid.uuid4())
    base = Path(KB_UPLOAD_DIR).resolve()
    base.mkdir(parents=True, exist_ok=True)
    safe_name = Path(file.filename or "upload.bin").name.replace("..", "_")
    dest = base / f"{upload_id}_{safe_name}"

    size = 0
    try:
        with dest.open("wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                out.write(chunk)
    finally:
        await file.close()

    checksum = sha256_file(dest)
    hint = (doc_id or "").strip() or None
    fname = file.filename or safe_name
    mime = file.content_type
    created = datetime.now().isoformat()

    async with async_session_maker() as db:
        row = KbSourceFile(
            id=upload_id,
            file_name=fname,
            stored_path=str(dest),
            checksum=checksum,
            mime_type=mime,
            size=size,
            created_at=created,
            doc_id_hint=hint,
        )
        db.add(row)
        await db.commit()

    log.info("kb_upload ok id=%s path=%s size=%s", upload_id, dest, size)
    return {"upload_id": upload_id, "file_name": fname, "size": size, "checksum": checksum, "doc_id_hint": hint}


@router.post("/ingest")
async def kb_ingest(body: KbIngestRequest):
    """同步执行 ingestion 并落库 kb_ingest_jobs。"""
    chroma = (body.chroma_url or CHROMA_HOST).strip()
    job_id = new_ingest_job_id()

    if body.source_type == "manifest":
        if not body.manifest:
            raise HTTPException(status_code=400, detail="manifest 模式需提供 manifest")
        manifest = dict(body.manifest)
        if body.collection:
            manifest["collection"] = body.collection
        payload = body.model_dump()
    elif body.source_type == "upload":
        if not body.upload_ids:
            raise HTTPException(status_code=400, detail="upload 模式需提供 upload_ids")
        async with async_session_maker() as db:
            rows = (
                await db.execute(select(KbSourceFile).where(KbSourceFile.id.in_(body.upload_ids)))
            ).scalars().all()
        by_id = {r.id: r for r in rows}
        missing = [uid for uid in body.upload_ids if uid not in by_id]
        if missing:
            raise HTTPException(status_code=400, detail=f"upload_ids 不存在: {missing}")
        ov = body.upload_doc_ids or {}
        items: list[dict[str, Any]] = []
        for r in rows:
            did = (ov.get(r.id) or "").strip() or (r.doc_id_hint or "").strip() or None
            items.append(
                {
                    "upload_id": r.id,
                    "stored_path": r.stored_path,
                    "file_name": r.file_name,
                    "checksum": r.checksum,
                    "doc_id": did,
                    "doc_id_hint": r.doc_id_hint,
                }
            )
        defaults = dict(body.defaults or {})
        batch_id = str(defaults.get("import_batch") or job_id)
        manifest = build_manifest_from_uploads(batch_id, body.collection, defaults, items)
        payload = body.model_dump()
    else:
        raise HTTPException(status_code=400, detail="source_type 必须是 manifest 或 upload")

    now = datetime.now().isoformat()
    async with async_session_maker() as db:
        job_row = KbIngestJob(
            id=job_id,
            source_type=body.source_type,
            collection=str(manifest.get("collection") or body.collection),
            status="running",
            payload_json=json.dumps(payload, ensure_ascii=False),
            result_json=None,
            created_at=now,
            updated_at=now,
            created_by=None,
        )
        db.add(job_row)
        await db.commit()

    report: dict[str, Any]
    try:
        report = await asyncio.to_thread(
            run_kb_ingestion,
            manifest=manifest,
            collection=str(manifest.get("collection") or body.collection),
            chroma_url=chroma,
            job_id=job_id,
            dry_run=False,
            batch_chunk_size=body.batch_chunk_size,
            strict_domain=body.strict_domain,
        )
        if body.sync_cache:
            try:
                sync_res = await kb_cache_service.sync_from_external(
                    external_kb_url=chroma,
                    project_id=body.project_id,
                    collections=[str(report.get("collection") or body.collection)],
                )
                report["cache_sync_triggered"] = True
                report["cache_sync_detail"] = sync_res
            except Exception as sync_e:
                log.warning("kb_ingest cache sync after upsert failed: %s", sync_e)
                report["cache_sync_triggered"] = False
                report["cache_sync_error"] = str(sync_e)
    except Exception as e:
        log.exception("kb_ingest failed job=%s", job_id)
        report = {
            "job_id": job_id,
            "status": "failed",
            "errors": [{"doc": "", "error": str(e)}],
            "cache_sync_triggered": False,
        }

    final_status = str(report.get("status") or "completed")
    async with async_session_maker() as db:
        row = (
            await db.execute(select(KbIngestJob).where(KbIngestJob.id == job_id))
        ).scalar_one_or_none()
        if row:
            row.status = final_status
            row.result_json = json.dumps(report, ensure_ascii=False)
            row.updated_at = datetime.now().isoformat()
            await db.commit()

    return report


@router.get("/ingest-jobs/{job_id}")
async def kb_ingest_job_get(job_id: str):
    async with async_session_maker() as db:
        row = (await db.execute(select(KbIngestJob).where(KbIngestJob.id == job_id))).scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="job 不存在")
    result = json.loads(row.result_json) if row.result_json else None
    return {
        "id": row.id,
        "source_type": row.source_type,
        "collection": row.collection,
        "status": row.status,
        "payload": json.loads(row.payload_json or "{}"),
        "result": result,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
        "created_by": row.created_by,
    }


@router.post("/publish")
async def kb_publish(body: KbPublishRequest):
    chroma = (body.chroma_url or CHROMA_HOST).strip()
    if not body.doc_ids:
        raise HTTPException(status_code=400, detail="doc_ids 不能为空")

    def _publish_sync() -> dict[str, Any]:
        client = ChromaHttpClient(chroma)
        if not client.heartbeat():
            raise RuntimeError(f"Chroma 不可达: {chroma}")
        if len(body.doc_ids) == 1:
            where: dict[str, Any] = {"doc_id": body.doc_ids[0]}
        else:
            where = {"doc_id": {"$in": body.doc_ids}}
        data = client.get_by_where(body.collection, where, limit=50_000, include=["metadatas"])
        ids = _flatten_get_ids(data)
        if not ids:
            return {"updated": 0, "doc_ids": body.doc_ids, "warning": "no_matching_chunks"}
        metas = [{"published": bool(body.published)} for _ in ids]
        client.update(body.collection, ids, metas)
        return {"updated": len(ids), "chunk_ids": ids}

    try:
        detail = await asyncio.to_thread(_publish_sync)
    except Exception as e:
        log.exception("kb_publish failed")
        raise HTTPException(status_code=500, detail=str(e)) from e

    if body.sync_cache:
        await kb_cache_service.sync_from_external(
            external_kb_url=chroma,
            project_id=body.project_id,
            collections=[body.collection],
        )
    detail["cache_synced"] = bool(body.sync_cache)
    return detail
