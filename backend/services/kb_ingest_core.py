"""
知识库 ingestion 核心逻辑：manifest 解析、切分、Chroma upsert。
供 CLI 脚本与 API 共用。
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

import httpx

from backend.services.chroma_client import ChromaHttpClient, flatten_chroma_get_ids
from backend.services.kb_embedding import (
    embed_model_name,
    embed_on_upsert_enabled,
    embed_texts_sync,
    extract_searchable_text,
)
from backend.services.kb_vault_assets import vault_relative_file
from backend.services.kb_contract import KB_DOMAIN_ENUM, KB_REQUIRED_METADATA_KEYS

logger = logging.getLogger("tpdx.hermes")


def new_ingest_job_id() -> str:
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    return f"ing_{ts}_{uuid.uuid4().hex[:8]}"


def _iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S%z")


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    out = dict(base or {})
    for k, v in (override or {}).items():
        if v is None:
            continue
        out[k] = v
    return out


def _read_text_file(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return f"sha256:{h.hexdigest()}"


def chunk_markdown_text(text: str, max_chars: int = 2000) -> list[str]:
    """按二级标题粗切，再对过长块按长度切开。"""
    cleaned = text.strip()
    if not cleaned:
        return []

    parts = re.split(r"(?m)^(?=#{2,3}\s)", cleaned)
    chunks: list[str] = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        if len(p) <= max_chars:
            chunks.append(p)
            continue
        start = 0
        while start < len(p):
            chunks.append(p[start : start + max_chars])
            start += max_chars
    return chunks if chunks else [cleaned[:max_chars]]


def validate_chunk_metadata(meta: dict[str, Any], strict_domain: bool = False) -> list[str]:
    """返回缺漏字段说明列表；空列表表示通过。"""
    errs: list[str] = []
    for k in KB_REQUIRED_METADATA_KEYS:
        v = meta.get(k)
        if v is None or (isinstance(v, str) and not str(v).strip()):
            errs.append(f"missing_metadata:{k}")
    dom = meta.get("domain")
    if strict_domain and isinstance(dom, str) and dom and dom not in KB_DOMAIN_ENUM:
        errs.append(f"unknown_domain:{dom}")
    return errs


def trigger_cache_sync_http(
    hermes_api_base: str,
    project_id: str,
    external_kb_url: str,
    collections: Optional[list[str]],
    timeout: float = 120.0,
) -> tuple[bool, Optional[str]]:
    """调用 Hermes POST /api/v1/kb/cache/sync（ hermes_api_base 不含 /api/v1）。"""
    url = f"{hermes_api_base.rstrip('/')}/api/v1/kb/cache/sync"
    body = {
        "project_id": project_id,
        "external_kb_url": external_kb_url,
        "collections": collections,
    }
    headers: dict[str, str] = {}
    api_key = (
        os.getenv("HERMES_API_KEY", "").strip()
        or os.getenv("X_API_KEY", "").strip()
        or os.getenv("API_SERVER_KEY", "").strip()
    )
    if api_key:
        headers["X-API-Key"] = api_key
    try:
        r = httpx.post(url, json=body, headers=headers, timeout=timeout)
        if r.status_code == 200:
            return True, None
        return False, f"HTTP {r.status_code}: {r.text[:500]}"
    except Exception as e:
        logger.warning("kb cache sync http failed: %s", e)
        return False, str(e)


def delete_stale_chunks_for_doc(
    client: ChromaHttpClient,
    collection: str,
    doc_id: str,
    keep_ids: set[str],
) -> int:
    """删除该 doc_id 下不在 keep_ids 中的旧 chunk（新版本 chunk 变少时避免脏数据残留）。"""
    try:
        data = client.get_by_where(
            collection,
            {"doc_id": doc_id},
            limit=100_000,
            include=["metadatas"],
        )
    except Exception as e:
        logger.warning("stale chunk cleanup: get failed doc_id=%s %s", doc_id, e)
        return 0
    existing = set(flatten_chroma_get_ids(data))
    stale = existing - keep_ids
    if not stale:
        return 0
    client.delete(collection, sorted(stale))
    return len(stale)


def run_kb_ingestion(
    *,
    manifest: dict[str, Any],
    collection: str,
    chroma_url: str,
    job_id: str,
    dry_run: bool = False,
    batch_chunk_size: int = 64,
    strict_domain: bool = False,
    ingest_job_id_in_meta: bool = True,
    on_doc_error: Optional[Callable[[str, str], None]] = None,
) -> dict[str, Any]:
    """
    执行 ingestion，返回与 guide 一致的结构化 report dict。
    cache 同步由调用方负责（CLI：`kb_ingest.py` 内 HTTP；服务端：`kb_cache_service.sync_from_external`）。

    manifest: 格式 A（batch_id, defaults, documents[]）。
    collection: CLI 可覆盖 manifest['collection']。
    """
    started = _iso_now()
    errors: list[dict[str, str]] = []
    doc_total = doc_succeeded = doc_failed = 0
    chunk_total = chunk_upserted = chunk_skipped = 0
    chunks_deleted_stale = 0

    batch_id = str(manifest.get("batch_id") or "")
    col = (manifest.get("collection") or collection or "").strip()
    if not col:
        raise ValueError("collection 不能为空")

    defaults = dict(manifest.get("defaults") or {})
    documents = manifest.get("documents")
    if not isinstance(documents, list) or not documents:
        raise ValueError("manifest.documents 必须为非空数组")

    client = ChromaHttpClient(chroma_url)
    if not dry_run and not client.heartbeat():
        raise RuntimeError(f"Chroma 不可达: {chroma_url}")

    if not dry_run:
        client.ensure_collection(
            col,
            metadata={
                "kb_embed_model": embed_model_name(),
                "kb_embed_client": "tpdhermes",
            },
        )

    for doc in documents:
        doc_total += 1
        if not isinstance(doc, dict):
            doc_failed += 1
            errors.append({"doc": "", "error": "document_entry_not_object"})
            continue
        doc_id = str(doc.get("doc_id") or "").strip()
        file_path = doc.get("file_path")
        if not doc_id:
            doc_failed += 1
            errors.append({"doc": "", "error": "missing_doc_id"})
            continue
        if not file_path:
            doc_failed += 1
            errors.append({"doc": doc_id, "error": "missing_file_path"})
            continue
        path = Path(str(file_path)).expanduser()
        if not path.is_file():
            doc_failed += 1
            errors.append({"doc": doc_id, "error": f"file_not_found:{path}"})
            if on_doc_error:
                on_doc_error(doc_id, f"file_not_found:{path}")
            continue

        try:
            body = _read_text_file(path)
        except Exception as e:
            doc_failed += 1
            errors.append({"doc": doc_id, "error": f"read_error:{e}"})
            continue

        merged = _deep_merge(defaults, doc)
        title = str(merged.get("title") or path.stem)
        domain = str(merged.get("domain") or defaults.get("domain") or "")
        folder_path = str(merged.get("folder_path") or defaults.get("folder_path") or "")
        source = str(merged.get("source") or defaults.get("source") or "manual_import")
        published = merged.get("published")
        if published is None:
            published = bool(defaults.get("published", True))
        published = bool(published)

        source_type = str(
            merged.get("source_type") or defaults.get("source_type") or ""
        ).strip()
        skip_embed_upsert = source_type == "conversation_harvest"

        chunks = chunk_markdown_text(body)
        chunk_count = len(chunks)
        checksum = sha256_file(path)
        source_vault_file = vault_relative_file(path)

        ids: list[str] = []
        docs_out: list[str] = []
        metas_out: list[dict[str, Any]] = []

        for idx, ch in enumerate(chunks):
            chunk_index = idx + 1
            chunk_id = f"{doc_id}_chunk_{chunk_index:04d}"
            base_meta: dict[str, Any] = {
                "id": chunk_id,
                "title": title,
                "domain": domain,
                "folder_path": folder_path,
                "tags": merged.get("tags") or defaults.get("tags") or [],
                "source": source,
                "source_url": merged.get("source_url") or defaults.get("source_url") or "",
                "source_type": merged.get("source_type") or defaults.get("source_type") or "file",
                "published": published,
                "linked_kg_ids": merged.get("linked_kg_ids") or [],
                "doc_id": doc_id,
                "chunk_index": chunk_index,
                "chunk_count": chunk_count,
                "version": int(merged.get("version") or 1),
                "checksum": checksum,
                "collection": col,
                "language": merged.get("language") or defaults.get("language") or "",
                "batch_id": batch_id,
                "import_batch": batch_id,
                "created_at": started,
                "updated_at": started,
            }
            if source_vault_file:
                base_meta["source_vault_file"] = source_vault_file
            if ingest_job_id_in_meta:
                base_meta["ingest_job_id"] = job_id
            if merged.get("authors"):
                base_meta["authors"] = merged["authors"]
            if merged.get("projects") is not None:
                base_meta["projects"] = merged["projects"]
            if merged.get("project_ids") is not None:
                base_meta["project_ids"] = merged["project_ids"]

            # conversation_harvest / 扩展 tracing 字段（不落 REQUIRED 校验范围）
            for _hk in (
                "dedupe_key",
                "conversation_id",
                "confidence",
                "harvested_from_user_confirmed",
                "trace_id",
                "created_by",
                "scenario_id",
                "project_id",
                "source_id",
                "output_status",
                "entrypoint",
            ):
                if merged.get(_hk) is not None:
                    base_meta[_hk] = merged[_hk]
            if merged.get("message_ids") is not None:
                base_meta["message_ids"] = merged["message_ids"]

            verr = validate_chunk_metadata(base_meta, strict_domain=strict_domain)
            if verr:
                doc_failed += 1
                for e in verr:
                    errors.append({"doc": doc_id, "error": e})
                if on_doc_error:
                    on_doc_error(doc_id, verr[0])
                ids.clear()
                docs_out.clear()
                metas_out.clear()
                break

            ids.append(chunk_id)
            docs_out.append(ch)
            metas_out.append(base_meta)
            chunk_total += 1

        if not ids:
            continue

        if dry_run:
            chunk_skipped += len(ids)
            doc_succeeded += 1
            continue

        try:
            for i in range(0, len(ids), batch_chunk_size):
                batch_ids = ids[i : i + batch_chunk_size]
                batch_docs = docs_out[i : i + batch_chunk_size]
                batch_metas = metas_out[i : i + batch_chunk_size]
                batch_embeddings = None
                if embed_on_upsert_enabled() and not skip_embed_upsert:
                    embed_inputs = [
                        extract_searchable_text(doc, meta)
                        for doc, meta in zip(batch_docs, batch_metas)
                    ]
                    batch_embeddings = embed_texts_sync(embed_inputs)
                client.upsert(
                    col,
                    batch_ids,
                    batch_docs,
                    batch_metas,
                    embeddings=batch_embeddings,
                )
            chunks_deleted_stale += delete_stale_chunks_for_doc(
                client, col, doc_id, set(ids)
            )
            chunk_upserted += len(ids)
            doc_succeeded += 1
        except Exception as e:
            doc_failed += 1
            msg = str(e)
            errors.append({"doc": doc_id, "error": f"chroma_upsert:{msg}"})
            logger.exception("kb ingest upsert failed doc_id=%s", doc_id)

    try:
        from backend.services.kb_proxy import kb_proxy_service

        kb_proxy_service.clear_caches()
    except Exception:
        pass

    finished = _iso_now()
    status = "failed" if doc_succeeded == 0 and doc_failed > 0 else "completed"
    report = {
        "job_id": job_id,
        "batch_id": batch_id,
        "collection": col,
        "status": status,
        "doc_total": doc_total,
        "doc_succeeded": doc_succeeded,
        "doc_failed": doc_failed,
        "chunk_total": chunk_total,
        "chunk_upserted": chunk_upserted,
        "chunk_skipped": chunk_skipped,
        "chunks_deleted_stale": chunks_deleted_stale,
        "cache_sync_triggered": False,
        "cache_sync_error": None,
        "started_at": started,
        "finished_at": finished,
        "errors": errors,
        "dry_run": dry_run,
    }
    return report


def build_manifest_from_uploads(
    batch_id: str,
    collection: str,
    defaults: dict[str, Any],
    items: list[dict[str, Any]],
) -> dict[str, Any]:
    """
    items: upload_id, stored_path, file_name?, doc_id?, doc_id_hint?, checksum?
    doc_id 优先级：显式 doc_id > doc_id_hint > doc_id_strategy（filename|checksum）> 磁盘路径 stem
    """
    documents: list[dict[str, Any]] = []
    strategy = str(defaults.get("doc_id_strategy") or "filename").strip().lower()
    for it in items:
        p = it.get("stored_path")
        if not p:
            continue
        explicit = str(it.get("doc_id") or "").strip()
        hint = str(it.get("doc_id_hint") or "").strip()
        file_name = str(it.get("file_name") or "")
        checksum = str(it.get("checksum") or "")
        if explicit:
            doc_id = explicit
        elif hint:
            doc_id = hint
        elif strategy == "checksum" and checksum.startswith("sha256:"):
            doc_id = f"doc_{checksum[7:23]}"
        elif file_name:
            doc_id = Path(file_name).stem
        else:
            doc_id = Path(str(p)).stem
        row = {"doc_id": doc_id, "file_path": str(p)}
        for k in (
            "title",
            "folder_path",
            "domain",
            "tags",
            "source_url",
            "published",
            "linked_kg_ids",
            "language",
            "source_type",
        ):
            if k in it and it[k] is not None:
                row[k] = it[k]
        documents.append(row)
    return {
        "batch_id": batch_id,
        "collection": collection,
        "defaults": defaults,
        "documents": documents,
    }


def build_manifest_from_harvest(
    batch_id: str,
    collection: str,
    doc_id: str,
    file_path: str,
    title: str,
    defaults: dict[str, Any],
) -> dict[str, Any]:
    """
    单次对话摘录导入：documents 一项，manifest.defaults 承载 domain/tags/source/source_type 等。
    """
    return {
        "batch_id": batch_id,
        "collection": collection,
        "defaults": dict(defaults or {}),
        "documents": [{"doc_id": doc_id, "file_path": str(file_path), "title": title}],
    }
