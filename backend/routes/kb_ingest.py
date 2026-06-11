"""
知识库导入 / 上传 / 发布 路由（与 kb.py 并列，prefix=/kb）。
"""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field
from backend.db import async_session_maker
from backend.models.kb_source_file import KbSourceFile
from backend.services.chroma_client import ChromaHttpClient, flatten_chroma_get_ids
from backend.services.kb_cache import kb_cache_service
from backend.services.kb_ingest_core import sha256_file
from backend.services.kb_ingest_job_service import (
    create_ingest_job,
    get_ingest_job,
    normalize_ingest_request,
    queue_ingest_job,
)
from backend.services.kb_proxy import CHROMA_HOST
from backend.services.kb_reembed import reembed_chroma_collection
from backend.services.kb_entry_manage import (
    create_kb_manual_entry,
    delete_kb_collection,
    delete_kb_entry,
    update_kb_entry,
)
from backend.services.kb_write import add_kb_harvest_entry

from backend.services.rbac import require_feature

router = APIRouter(
    prefix="/kb",
    tags=["knowledge_base"],
    dependencies=[Depends(require_feature("knowledge"))],
)
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


class KbEntryUpdateRequest(BaseModel):
    collection: str
    project_id: str = "__all__"
    sync_cache: bool = True
    chroma_url: Optional[str] = None
    title: Optional[str] = None
    content: Optional[str] = None
    metadata: Optional[dict[str, Any]] = None
    strict_domain: bool = False


class KbManualEntryRequest(BaseModel):
    collection: str
    project_id: str = "__all__"
    title: str
    content: str
    domain: str = "structured_tech"
    folder_path: str = "02-知识库/手动录入"
    published: bool = True
    doc_id: Optional[str] = None
    source_type: str = "manual"
    sync_cache: bool = True
    chroma_url: Optional[str] = None
    strict_domain: bool = False

class KbHarvestEntryRequest(BaseModel):
    """对话收割原子写入"""

    collection_name: str
    project_id: str
    title: str
    content: str
    summary: Optional[str] = None
    tags: Optional[list[str]] = None
    domain: str = "internal_methodology"
    source: str = "hermes_chat"
    published: bool = False
    metadata: Optional[dict[str, Any]] = None
    scenario_id: Optional[str] = None
    chroma_url: Optional[str] = None
    strict_domain: bool = False


def _flatten_get_ids(data: dict[str, Any]) -> list[str]:
    return flatten_chroma_get_ids(data)


@router.post("/entries")
async def kb_create_harvest_entry(body: KbHarvestEntryRequest):
    """对话确认的摘录入库：默认 unpublished 草稿。"""
    return await add_kb_harvest_entry(
        collection_name=body.collection_name.strip(),
        project_id=body.project_id.strip(),
        title=body.title,
        content=body.content,
        summary=body.summary,
        tags=body.tags,
        domain=body.domain,
        source=body.source,
        published=body.published,
        metadata=body.metadata,
        scenario_id=body.scenario_id,
        chroma_url=body.chroma_url,
        strict_domain=body.strict_domain,
    )


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
    """创建异步 ingestion 任务并立即返回 job_id。"""
    normalized = await normalize_ingest_request(body.model_dump())
    created = await create_ingest_job(normalized=normalized, created_by=None)
    await queue_ingest_job(str(created["job_id"]))
    return created


@router.get("/ingest-jobs/{job_id}")
async def kb_ingest_job_get(job_id: str):
    row = await get_ingest_job(job_id)
    if not row:
        raise HTTPException(status_code=404, detail="job 不存在")
    return row


@router.post("/entries/manual")
async def kb_create_manual_entry(body: KbManualEntryRequest):
    """手动新建知识条目（Markdown 正文，写入 Chroma 并同步缓存）。"""
    result = await create_kb_manual_entry(
        collection=body.collection,
        title=body.title,
        content=body.content,
        domain=body.domain,
        folder_path=body.folder_path,
        published=body.published,
        doc_id=body.doc_id,
        source_type=body.source_type,
        project_id=body.project_id,
        chroma_url=body.chroma_url,
        strict_domain=body.strict_domain,
        sync_cache=body.sync_cache,
    )
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("message") or "create_failed")
    return result


@router.patch("/entries/{doc_id}")
async def kb_update_entry(doc_id: str, body: KbEntryUpdateRequest):
    """更新条目 metadata；提供 content 时重新切分并 upsert。"""
    result = await update_kb_entry(
        collection=body.collection,
        doc_id=doc_id,
        project_id=body.project_id,
        chroma_url=body.chroma_url,
        title=body.title,
        content=body.content,
        metadata=body.metadata,
        strict_domain=body.strict_domain,
        sync_cache=body.sync_cache,
    )
    if not result.get("ok"):
        code = 404 if result.get("message") == "entry_not_found" else 400
        raise HTTPException(status_code=code, detail=result.get("message") or "update_failed")
    return result


@router.delete("/collections/{collection_name}/entries")
async def kb_delete_collection_entries(
    collection_name: str,
    confirm: bool = Query(False, description="必须为 true 才执行删除"),
    project_id: str = Query("__all__"),
    sync_cache: bool = Query(True),
    chroma_url: Optional[str] = Query(None),
):
    """删除指定 collection 在 Chroma 中的全部 chunk，并清理 kb_cache。"""
    if not confirm:
        raise HTTPException(status_code=400, detail="confirm=true required")
    result = await delete_kb_collection(
        collection=collection_name,
        project_id=project_id,
        chroma_url=chroma_url,
        sync_cache=sync_cache,
    )
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("message") or "delete_failed")
    return result


@router.delete("/entries/{doc_id}")
async def kb_delete_entry(
    doc_id: str,
    collection: str = Query(..., description="条目所在 collection"),
    project_id: str = Query("__all__"),
    sync_cache: bool = Query(True),
    chroma_url: Optional[str] = Query(None),
):
    """按 doc_id 删除 Chroma 中全部 chunk，并清理本地 kb_cache。"""
    result = await delete_kb_entry(
        collection=collection,
        doc_id=doc_id,
        project_id=project_id,
        chroma_url=chroma_url,
        sync_cache=sync_cache,
    )
    if not result.get("ok"):
        code = 404 if result.get("message") == "entry_not_found" else 400
        raise HTTPException(status_code=code, detail=result.get("message") or "delete_failed")
    return result


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


class KbReembedRequest(BaseModel):
    collection: str
    batch_size: int = Field(64, ge=1, le=256)
    dry_run: bool = False
    chroma_url: Optional[str] = None


@router.post("/collections/reembed")
async def kb_reembed_collection(body: KbReembedRequest):
    """
    对已有 collection 全量重算 embeddings（修复 Chroma dimension=null / 查询降级）。
    """
    chroma = (body.chroma_url or CHROMA_HOST).strip()
    try:
        report = await asyncio.to_thread(
            reembed_chroma_collection,
            chroma_url=chroma,
            collection=body.collection,
            batch_size=body.batch_size,
            dry_run=body.dry_run,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Exception as e:
        log.exception("kb_reembed failed collection=%s", body.collection)
        raise HTTPException(status_code=500, detail=str(e)) from e
    return report
