#!/usr/bin/env python3
"""
离线知识库导入：manifest → 切分 → Chroma upsert → 可选触发 kb_cache 同步。
用法见 guide/知识库改造.md。
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.services.kb_ingest_core import new_ingest_job_id, run_kb_ingestion, trigger_cache_sync_http  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("kb_ingest")


def main() -> int:
    p = argparse.ArgumentParser(description="KB manifest → Chroma → 可选 cache sync")
    p.add_argument("--manifest", required=True, help="manifest JSON 文件路径")
    p.add_argument("--collection", default="", help="覆盖 manifest.collection")
    p.add_argument("--chroma-url", default=os.getenv("CHROMA_HOST", "http://localhost:8001"))
    p.add_argument("--sync-cache", action="store_true", help="成功后 POST Hermes /kb/cache/sync")
    p.add_argument(
        "--hermes-api",
        default=os.getenv("HERMES_API_BASE", "http://localhost:8000"),
        help="Hermes API 根地址（无 /api/v1 后缀），供 --sync-cache",
    )
    p.add_argument("--project-id", default="__all__", help="sync 时的 project_id")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--strict-domain", action="store_true", help="校验 domain 在合同枚举内")
    p.add_argument("--output", help="将 report JSON 写入文件")
    p.add_argument("--batch-chunk-size", type=int, default=64, help="每批 upsert 的 chunk 数")
    args = p.parse_args()

    manifest_path = Path(args.manifest).expanduser()
    if not manifest_path.is_file():
        log.error("manifest 不存在: %s", manifest_path)
        return 2

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    job_id = new_ingest_job_id()
    col = (args.collection or "").strip() or str(manifest.get("collection") or "")

    try:
        report = run_kb_ingestion(
            manifest=manifest,
            collection=col,
            chroma_url=args.chroma_url,
            job_id=job_id,
            dry_run=args.dry_run,
            batch_chunk_size=args.batch_chunk_size,
            strict_domain=args.strict_domain,
        )
    except Exception as e:
        log.exception("ingest 失败: %s", e)
        return 1

    if args.sync_cache and not args.dry_run:
        ok, err = trigger_cache_sync_http(
            args.hermes_api,
            args.project_id,
            args.chroma_url,
            [str(report.get("collection") or col)],
        )
        report["cache_sync_triggered"] = ok
        report["cache_sync_error"] = err

    text = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(text, encoding="utf-8")
        log.info("report 已写入 %s", args.output)
    print(text)
    return 0 if report.get("doc_failed", 0) == 0 else 3


if __name__ == "__main__":
    raise SystemExit(main())
