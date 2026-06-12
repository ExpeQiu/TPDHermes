#!/usr/bin/env python3
"""
修复 Chroma 0.4.x topic=None 导致向量索引不可用的 collection：
导出文档 → 删除 collection → 重建并带 embeddings upsert。
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.services.chroma_client import ChromaHttpClient, flatten_chroma_get_ids  # noqa: E402
from backend.services.kb_embedding import (  # noqa: E402
    embed_enabled,
    embed_model_name,
    embed_texts_sync,
    extract_searchable_text,
)
from backend.services.kb_proxy import kb_proxy_service  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("kb_repair")


def _flatten_field(data: dict, key: str) -> list:
    raw = data.get(key) or []
    if raw and isinstance(raw[0], list):
        return list(raw[0])
    return list(raw)


def repair_chroma_collection(
    *,
    chroma_url: str,
    collection: str,
    batch_size: int = 64,
    dry_run: bool = False,
) -> dict:
    col = (collection or "").strip()
    if not col:
        raise ValueError("collection 不能为空")
    if not embed_enabled():
        raise RuntimeError("KB_EMBED_ENABLED 已关闭，无法 repair")

    client = ChromaHttpClient(chroma_url)
    if not client.heartbeat():
        raise RuntimeError(f"Chroma 不可达: {chroma_url}")

    records: list[tuple[str, str, dict]] = []
    offset = 0
    while True:
        data = client.get_by_where(
            col,
            {},
            limit=500,
            offset=offset,
            include=["documents", "metadatas"],
        )
        ids = flatten_chroma_get_ids(data)
        if not ids:
            break
        docs = _flatten_field(data, "documents")
        metas = _flatten_field(data, "metadatas")
        for cid, doc, meta in zip(ids, docs, metas):
            records.append((str(cid), str(doc or ""), dict(meta or {})))
        if len(ids) < 500:
            break
        offset += len(ids)

    log.info("repair export collection=%s chunks=%s", col, len(records))
    if dry_run:
        return {
            "collection": col,
            "status": "dry_run",
            "chunks_exported": len(records),
            "dry_run": True,
        }
    if not records:
        return {"collection": col, "status": "skipped", "reason": "empty_collection"}

    # Chroma 0.4.x 按 UUID 删除会 500，须用 collection name
    base = chroma_url.rstrip("/")
    resp = httpx.delete(f"{base}/api/v1/collections/{col}", timeout=120)
    log.info("delete_collection collection=%s status=%s", col, resp.status_code)
    resp.raise_for_status()

    client.create_collection(
        col,
        metadata={
            "kb_embed_model": embed_model_name(),
            "kb_embed_client": "tpdhermes",
        },
    )

    total = 0
    batches = 0
    for i in range(0, len(records), batch_size):
        batch = records[i : i + batch_size]
        ids = [r[0] for r in batch]
        docs = [r[1] for r in batch]
        metas = [r[2] for r in batch]
        texts = [
            extract_searchable_text(doc, meta) or " "
            for doc, meta in zip(docs, metas)
        ]
        vectors = embed_texts_sync(texts)
        client.upsert(col, ids, docs, metas, embeddings=vectors)
        total += len(batch)
        batches += 1
        log.info("repair upsert collection=%s batch=%s chunks=%s", col, batches, len(batch))

    kb_proxy_service.clear_caches()
    return {
        "collection": col,
        "status": "completed",
        "chunks_repaired": total,
        "batches": batches,
        "embed_model": embed_model_name(),
        "dry_run": False,
    }


def main() -> int:
    p = argparse.ArgumentParser(description="修复 Chroma collection 向量段 topic=None")
    p.add_argument("--collection", required=True)
    p.add_argument("--chroma-url", default="http://localhost:8001")
    p.add_argument("--batch-size", type=int, default=64)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--output", help="report JSON 路径")
    args = p.parse_args()

    try:
        report = repair_chroma_collection(
            chroma_url=args.chroma_url,
            collection=args.collection,
            batch_size=args.batch_size,
            dry_run=args.dry_run,
        )
    except Exception as e:
        log.exception("repair 失败: %s", e)
        return 1

    text = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
