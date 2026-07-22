"""
项目附件 / 输出沉淀 → project.{uuid}.kb 统一入库。
"""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from backend.db import async_session_maker
from backend.models.orchestration_run import OrchestrationRun
from backend.models.output_asset import OutputAsset
from backend.models.project_attachment import ProjectAttachment
from backend.services.chroma_client import ChromaHttpClient, flatten_chroma_get_ids
from backend.services.document_extract import DocumentExtractError, extract_to_markdown
from backend.services.kb_cache import kb_cache_service
from backend.services.kb_ingest_core import (
    build_manifest_from_harvest,
    new_ingest_job_id,
    run_kb_ingestion,
)
from backend.services.kb_proxy import CHROMA_HOST
from backend.services.kb_write import build_markdown_body, project_kb_md_root
from backend.services.project_kb import (
    attachment_doc_id,
    ensure_project_kb_collection_in_config,
    output_doc_id,
    output_published_for_status,
    project_kb_collection,
    project_kb_ingest_enabled,
)

log = logging.getLogger("tpdx.hermes.project_kb_ingest")

DOMAIN = "internal_methodology"


def _attachments_root() -> Path:
    override = os.getenv("PROJECT_UPLOAD_DIR", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return (Path(__file__).resolve().parent.parent / "data" / "project_uploads").resolve()


@dataclass
class IngestResult:
    ok: bool
    doc_id: str | None = None
    collection: str | None = None
    chunk_count: int = 0
    message: str = ""
    trace_id: str = ""


def _project_kb_md_dir(project_id: str) -> Path:
    base = project_kb_md_root(project_id)
    base.mkdir(parents=True, exist_ok=True)
    return base


def _ingest_markdown_sync(
    *,
    project_id: str,
    doc_id: str,
    title: str,
    markdown_body: str,
    folder_path: str,
    source_type: str,
    source_id: str,
    published: bool,
    output_status: str | None = None,
    scenario_id: str | None = None,
    entrypoint: str | None = None,
    version: str | None = None,
    chroma_url: str | None = None,
) -> tuple[IngestResult, str, str]:
    trace_id = str(uuid.uuid4())
    if not project_kb_ingest_enabled():
        return IngestResult(ok=False, message="project_kb_ingest_disabled", trace_id=trace_id), "", ""

    pid = str(project_id).strip()
    collection = project_kb_collection(pid)
    chroma = (chroma_url or CHROMA_HOST).strip()
    client = ChromaHttpClient(chroma)
    if not client.heartbeat():
        log.warning("project_kb_ingest chroma unreachable trace=%s", trace_id)
        return IngestResult(ok=False, message="kb_unavailable", trace_id=trace_id), chroma, pid

    content = (markdown_body or "").strip()
    if not content:
        return IngestResult(ok=False, message="empty_content", trace_id=trace_id), chroma, pid

    md_path = _project_kb_md_dir(pid) / f"{doc_id}.md"
    md_path.write_text(build_markdown_body(title, None, content), encoding="utf-8")

    batch_id = new_ingest_job_id()
    defaults: dict[str, Any] = {
        "domain": DOMAIN,
        "folder_path": folder_path,
        "source": "project_kb",
        "source_type": source_type,
        "published": bool(published),
        "project_id": pid,
        "source_id": source_id,
        "trace_id": trace_id,
    }
    if output_status:
        defaults["output_status"] = output_status
    if scenario_id:
        defaults["scenario_id"] = scenario_id
    if entrypoint:
        defaults["entrypoint"] = entrypoint
    if version:
        defaults["version"] = version

    manifest = build_manifest_from_harvest(
        batch_id=batch_id,
        collection=collection,
        doc_id=doc_id,
        file_path=str(md_path),
        title=title.strip() or doc_id,
        defaults=defaults,
    )

    try:
        report = run_kb_ingestion(
            manifest=manifest,
            collection=collection,
            chroma_url=chroma,
            job_id=batch_id,
            dry_run=False,
            strict_domain=False,
        )
    except Exception as e:
        log.exception("project_kb_ingest failed trace=%s doc=%s", trace_id, doc_id)
        return IngestResult(ok=False, message=str(e), trace_id=trace_id), chroma, pid

    if (report.get("doc_succeeded") or 0) < 1:
        err = (report.get("errors") or [{}])[0]
        return IngestResult(
            ok=False,
            message=str(err.get("error", "ingest_failed")),
            trace_id=trace_id,
        ), chroma, pid

    chunk_count = int(report.get("chunk_upserted") or 0)
    log.info(
        "project_kb_ingest ok trace=%s project=%s doc=%s chunks=%s published=%s",
        trace_id,
        pid[:24],
        doc_id,
        chunk_count,
        published,
    )
    return (
        IngestResult(
            ok=True,
            doc_id=doc_id,
            collection=collection,
            chunk_count=chunk_count,
            message="ingested",
            trace_id=trace_id,
        ),
        chroma,
        pid,
    )


async def _sync_after_ingest(
    chroma_url: str,
    project_id: str,
    collection: str,
    *,
    doc_id: str | None = None,
) -> None:
    try:
        if doc_id:
            await kb_cache_service.sync_selection_from_external(
                external_kb_url=chroma_url,
                project_id=project_id,
                collection=collection,
                doc_ids=[doc_id],
            )
            return
        await kb_cache_service.sync_from_external(
            external_kb_url=chroma_url,
            project_id=project_id,
            collections=[collection],
        )
    except Exception as e:
        log.warning("project_kb cache sync failed project=%s: %s", project_id[:24], e)


async def _run_ingest_and_sync(fn, *args, **kwargs) -> IngestResult:
    raw = await asyncio.to_thread(fn, *args, **kwargs)
    if isinstance(raw, tuple) and len(raw) == 3:
        result, chroma, proj = raw
        if result.ok and chroma and proj and result.collection:
            await _sync_after_ingest(
                str(chroma),
                str(proj),
                result.collection,
                doc_id=result.doc_id,
            )
        return result
    return raw  # type: ignore[return-value]


def delete_doc_from_collection(
    collection: str,
    doc_id: str,
    chroma_url: str | None = None,
) -> int:
    chroma = (chroma_url or CHROMA_HOST).strip()
    client = ChromaHttpClient(chroma)
    if not client.heartbeat():
        log.warning("delete_doc chroma unreachable doc=%s", doc_id)
        return 0
    try:
        data = client.get_by_where(
            collection,
            {"doc_id": doc_id},
            limit=100_000,
            include=["metadatas"],
        )
    except Exception as e:
        log.warning("delete_doc get failed doc=%s err=%s", doc_id, e)
        return 0
    ids = flatten_chroma_get_ids(data)
    if not ids:
        return 0
    client.delete(collection, sorted(ids))
    log.info("delete_doc collection=%s doc=%s removed=%s", collection, doc_id, len(ids))
    return len(ids)


def unpublish_doc_in_collection(
    collection: str,
    doc_id: str,
    chroma_url: str | None = None,
) -> bool:
    """archive：删除全部 chunk（比 patch metadata 更简单可靠）。"""
    n = delete_doc_from_collection(collection, doc_id, chroma_url)
    return n >= 0


async def ingest_project_attachment(attachment_id: str) -> IngestResult:
    async with async_session_maker() as db:
        row = await db.get(ProjectAttachment, attachment_id)
        if not row:
            return IngestResult(ok=False, message="attachment_not_found")

        row.ingest_status = "extracting"
        row.ingest_error = None
        await db.commit()

        project_id = row.project_id
        doc_id = attachment_doc_id(row.id)
        collection = project_kb_collection(project_id)
        path = _attachments_root() / row.stored_path

        try:
            md = extract_to_markdown(path, content_type=row.content_type)
        except DocumentExtractError as e:
            row.ingest_status = "failed"
            row.ingest_error = str(e)
            await db.commit()
            return IngestResult(ok=False, message=str(e), doc_id=doc_id)

        title = row.original_filename or doc_id
        result = await _run_ingest_and_sync(
            _ingest_markdown_sync,
            project_id=project_id,
            doc_id=doc_id,
            title=title,
            markdown_body=md,
            folder_path="attachments",
            source_type="project_attachment",
            source_id=row.id,
            published=True,
        )

        now = datetime.now().isoformat()
        if result.ok:
            row.ingest_status = "ingested"
            row.kb_collection = collection
            row.kb_doc_id = doc_id
            row.chunk_count = result.chunk_count
            row.ingested_at = now
            row.ingest_error = None
            await ensure_project_kb_collection_in_config(db, project_id)
        else:
            row.ingest_status = "failed"
            row.ingest_error = result.message
        await db.commit()
        return result


async def ingest_project_output(output_id: str) -> IngestResult:
    async with async_session_maker() as db:
        row = await db.get(OutputAsset, output_id)
        if not row:
            return IngestResult(ok=False, message="output_not_found")

        if (row.status or "").strip().lower() == "archived":
            return IngestResult(ok=False, message="output_archived")

        row.kb_ingest_status = "pending"
        row.kb_ingest_error = None
        await db.commit()

        project_id = row.project_id
        doc_id = output_doc_id(row.id)
        published = output_published_for_status(row.status)
        title = (row.title or "项目输出").strip() or doc_id
        content = (row.content or "").strip()
        if not content:
            row.kb_ingest_status = "failed"
            row.kb_ingest_error = "empty_content"
            await db.commit()
            return IngestResult(ok=False, message="empty_content", doc_id=doc_id)

        entrypoint: str | None = None
        if row.run_id:
            run = await db.get(OrchestrationRun, row.run_id)
            if run:
                entrypoint = run.entrypoint

        result = await _run_ingest_and_sync(
            _ingest_markdown_sync,
            project_id=project_id,
            doc_id=doc_id,
            title=title,
            markdown_body=content,
            folder_path="outputs",
            source_type="project_output",
            source_id=row.id,
            published=published,
            output_status=row.status,
            scenario_id=getattr(row, "scenario_id", None),
            entrypoint=entrypoint,
            version=getattr(row, "version", None) or "1",
        )

        now = datetime.now().isoformat()
        if result.ok:
            row.kb_ingest_status = "ingested"
            row.kb_doc_id = doc_id
            row.kb_chunk_count = result.chunk_count
            row.kb_ingested_at = now
            row.kb_ingest_error = None
            await ensure_project_kb_collection_in_config(db, project_id)
        else:
            row.kb_ingest_status = "failed"
            row.kb_ingest_error = result.message
        await db.commit()
        return result


async def set_output_kb_visibility(output_id: str, *, published: bool) -> IngestResult:
    """approve → re-ingest published=true；archive → 删除 chunk。"""
    async with async_session_maker() as db:
        row = await db.get(OutputAsset, output_id)
        if not row:
            return IngestResult(ok=False, message="output_not_found")

        doc_id = output_doc_id(row.id)
        collection = project_kb_collection(row.project_id)

        if not published:
            delete_doc_from_collection(collection, doc_id)
            row.kb_ingest_status = "removed"
            row.kb_ingest_error = None
            await db.commit()
            return IngestResult(ok=True, doc_id=doc_id, collection=collection, message="removed")

    return await ingest_project_output(output_id)


async def remove_attachment_from_kb(attachment_id: str) -> None:
    async with async_session_maker() as db:
        row = await db.get(ProjectAttachment, attachment_id)
        if not row or not row.kb_doc_id or not row.kb_collection:
            return
        delete_doc_from_collection(row.kb_collection, row.kb_doc_id)


def schedule_ingest_attachment(attachment_id: str) -> None:
    if not project_kb_ingest_enabled():
        return

    async def _run() -> None:
        try:
            await ingest_project_attachment(attachment_id)
        except Exception:
            log.exception("schedule ingest attachment failed id=%s", attachment_id)

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_run())
    except RuntimeError:
        asyncio.run(_run())


def schedule_ingest_output(output_id: str) -> None:
    if not project_kb_ingest_enabled():
        return

    async def _run() -> None:
        try:
            await ingest_project_output(output_id)
        except Exception:
            log.exception("schedule ingest output failed id=%s", output_id)

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_run())
    except RuntimeError:
        asyncio.run(_run())


def schedule_output_kb_visibility(output_id: str, *, published: bool) -> None:
    if not project_kb_ingest_enabled():
        return

    async def _run() -> None:
        try:
            await set_output_kb_visibility(output_id, published=published)
        except Exception:
            log.exception("schedule output kb visibility failed id=%s", output_id)

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_run())
    except RuntimeError:
        asyncio.run(_run())


def schedule_remove_attachment_kb(attachment_id: str) -> None:
    async def _run() -> None:
        try:
            await remove_attachment_from_kb(attachment_id)
        except Exception:
            log.exception("schedule remove attachment kb failed id=%s", attachment_id)

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_run())
    except RuntimeError:
        asyncio.run(_run())
