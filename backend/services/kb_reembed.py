"""
对已有 Chroma collection 批量重算并写回 embeddings（修复 dimension=null / 无向量历史数据）。
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from backend.services.chroma_client import ChromaHttpClient, flatten_chroma_get_ids
from backend.services.kb_embedding import (
    embed_enabled,
    embed_model_name,
    embed_texts_sync,
    extract_searchable_text,
)
from backend.services.kb_proxy import kb_proxy_service

logger = logging.getLogger("tpdx.hermes")


def _iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S%z")


def _flatten_get_field(data: dict[str, Any], key: str) -> list[Any]:
    raw = data.get(key) or []
    if raw and isinstance(raw[0], list):
        return list(raw[0])
    return list(raw)


def reembed_chroma_collection(
    *,
    chroma_url: str,
    collection: str,
    batch_size: int = 64,
    dry_run: bool = False,
) -> dict[str, Any]:
    """
    分页拉取 collection 内全部 chunk，按当前 KB_EMBED_MODEL 重算向量并 upsert。
    """
    col = (collection or "").strip()
    if not col:
        raise ValueError("collection 不能为空")
    if not embed_enabled():
        raise RuntimeError("KB_EMBED_ENABLED 已关闭，无法 re-embed")

    client = ChromaHttpClient(chroma_url)
    if not client.heartbeat():
        raise RuntimeError(f"Chroma 不可达: {chroma_url}")

    client.ensure_collection(
        col,
        metadata={
            "kb_embed_model": embed_model_name(),
            "kb_embed_client": "tpdhermes",
        },
    )

    total = 0
    batches = 0
    offset = 0
    page_size = 500

    while True:
        data = client.get_by_where(
            col,
            {},
            limit=page_size,
            offset=offset,
            include=["documents", "metadatas"],
        )
        ids = flatten_chroma_get_ids(data)
        if not ids:
            break

        docs = _flatten_get_field(data, "documents")
        metas = _flatten_get_field(data, "metadatas")
        records: list[tuple[str, str, dict[str, Any]]] = []
        for cid, doc, meta in zip(ids, docs, metas):
            records.append((str(cid), str(doc or ""), dict(meta or {})))

        for i in range(0, len(records), batch_size):
            batch = records[i : i + batch_size]
            batch_ids = [r[0] for r in batch]
            batch_docs = [r[1] for r in batch]
            batch_metas = [r[2] for r in batch]
            texts = [
                extract_searchable_text(doc, meta) or " "
                for doc, meta in zip(batch_docs, batch_metas)
            ]
            if dry_run:
                total += len(batch)
                batches += 1
                continue
            vectors = embed_texts_sync(texts)
            client.upsert(
                col,
                batch_ids,
                batch_docs,
                batch_metas,
                embeddings=vectors,
            )
            total += len(batch)
            batches += 1
            logger.info(
                "kb reembed collection=%s batch=%s chunks=%s",
                col,
                batches,
                len(batch),
            )

        if len(ids) < page_size:
            break
        offset += len(ids)

    if not dry_run:
        kb_proxy_service.clear_caches()

    return {
        "collection": col,
        "status": "completed",
        "chunks_reembedded": total,
        "batches": batches,
        "embed_model": embed_model_name(),
        "dry_run": dry_run,
        "finished_at": _iso_now(),
    }
