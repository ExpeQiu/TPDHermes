#!/usr/bin/env python3
"""
从远端 Chroma 导出 collection（含 embeddings），写入本地 Chroma。
用于本地无法跑 embedding 时与云端向量库对齐。
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

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("kb_sync_chroma")


def _flatten_field(data: dict, key: str) -> list:
    raw = data.get(key) or []
    if raw and isinstance(raw[0], list):
        return list(raw[0])
    return list(raw)


def _flatten_embeddings(data: dict) -> list[list[float]]:
    raw = data.get("embeddings")
    if not raw:
        return []
    # 常见：[[f,...], [f,...]] 与 ids 等长
    if isinstance(raw[0], list) and raw[0] and isinstance(raw[0][0], (int, float)):
        return [list(map(float, v)) for v in raw]
    # 少数响应：[[[f,...], ...]]
    if isinstance(raw[0], list) and raw[0] and isinstance(raw[0][0], list):
        return [list(map(float, v)) for v in raw[0]]
    return []


def export_collection(client: ChromaHttpClient, collection: str) -> dict:
    records: list[dict] = []
    offset = 0
    while True:
        data = client.get_by_where(
            collection,
            {},
            limit=500,
            offset=offset,
            include=["documents", "metadatas", "embeddings"],
        )
        ids = flatten_chroma_get_ids(data)
        if not ids:
            break
        docs = _flatten_field(data, "documents")
        metas = _flatten_field(data, "metadatas")
        embs = _flatten_embeddings(data)
        if len(embs) != len(ids):
            raise RuntimeError(
                f"collection={collection} ids={len(ids)} embeddings={len(embs)} 数量不一致"
            )
        for cid, doc, meta, emb in zip(ids, docs, metas, embs):
            records.append(
                {
                    "id": str(cid),
                    "document": str(doc or ""),
                    "metadata": dict(meta or {}),
                    "embedding": emb,
                }
            )
        if len(ids) < 500:
            break
        offset += len(ids)
    return {"collection": collection, "count": len(records), "records": records}


def import_collection(
    client: ChromaHttpClient,
    *,
    collection: str,
    records: list[dict],
    batch_size: int = 64,
    recreate: bool = True,
) -> dict:
    col = collection.strip()
    base = client.base_url.rstrip("/")
    if recreate and col in client.collection_names():
        resp = httpx.delete(f"{base}/api/v1/collections/{col}", timeout=120)
        log.info("delete local collection=%s status=%s", col, resp.status_code)
        if resp.status_code not in (200, 404):
            resp.raise_for_status()

    client.create_collection(col, metadata={"kb_sync_source": "remote_chroma"})

    total = 0
    batches = 0
    for i in range(0, len(records), batch_size):
        batch = records[i : i + batch_size]
        ids = [r["id"] for r in batch]
        docs = [r["document"] for r in batch]
        metas = [r["metadata"] for r in batch]
        embs = [r["embedding"] for r in batch]
        if not all(embs):
            raise RuntimeError(f"collection={col} 存在空 embedding，无法同步")
        client.upsert(col, ids, docs, metas, embeddings=embs)
        total += len(batch)
        batches += 1
        log.info("import collection=%s batch=%s chunks=%s", col, batches, len(batch))

    return {"collection": col, "chunks_imported": total, "batches": batches}


def main() -> int:
    p = argparse.ArgumentParser(description="远端 Chroma → 本地 Chroma 向量同步")
    p.add_argument("--mode", choices=["export", "import"], required=True)
    p.add_argument("--collection", action="append", required=True, help="可重复指定")
    p.add_argument("--source-url", help="export 时远端 Chroma URL")
    p.add_argument("--target-url", default="http://127.0.0.1:8001", help="import 时本地 Chroma URL")
    p.add_argument("--data-dir", default=str(ROOT / "data" / "chroma_sync"), help="导出 JSON 目录")
    p.add_argument("--batch-size", type=int, default=64)
    p.add_argument("--no-recreate", action="store_true", help="import 时不删本地 collection")
    args = p.parse_args()

    data_dir = Path(args.data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)

    if args.mode == "export":
        if not args.source_url:
            p.error("export 需要 --source-url")
        client = ChromaHttpClient(args.source_url)
        if not client.heartbeat():
            log.error("远端 Chroma 不可达: %s", args.source_url)
            return 1
        for col in args.collection:
            payload = export_collection(client, col)
            out = data_dir / f"{col.replace('/', '__')}.json"
            out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            log.info("exported %s chunks=%s -> %s", col, payload["count"], out)
        return 0

    client = ChromaHttpClient(args.target_url)
    if not client.heartbeat():
        log.error("本地 Chroma 不可达: %s", args.target_url)
        return 1
    for col in args.collection:
        src = data_dir / f"{col.replace('/', '__')}.json"
        if not src.is_file():
            log.error("缺少导出文件: %s", src)
            return 1
        payload = json.loads(src.read_text(encoding="utf-8"))
        report = import_collection(
            client,
            collection=col,
            records=payload.get("records") or [],
            batch_size=args.batch_size,
            recreate=not args.no_recreate,
        )
        log.info("imported %s", json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
