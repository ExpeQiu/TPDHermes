#!/usr/bin/env python3
"""
对 Chroma collection 全量重算 embeddings（修复无向量 / dimension=null 导致查询降级）。

示例:
  python3 scripts/kb_reembed_collection.py \\
    --collection public.structured_tech.remote_debug \\
    --chroma-url http://localhost:8001
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

from backend.services.kb_reembed import reembed_chroma_collection  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("kb_reembed")


def main() -> int:
    p = argparse.ArgumentParser(description="Chroma collection 全量 re-embed")
    p.add_argument("--collection", required=True, help="collection 名称")
    p.add_argument(
        "--chroma-url",
        default=os.getenv("CHROMA_HOST", "http://localhost:8001"),
    )
    p.add_argument("--batch-size", type=int, default=64)
    p.add_argument("--dry-run", action="store_true", help="仅统计 chunk 数，不写回")
    p.add_argument("--output", help="将 report JSON 写入文件")
    args = p.parse_args()

    try:
        report = reembed_chroma_collection(
            chroma_url=args.chroma_url,
            collection=args.collection,
            batch_size=args.batch_size,
            dry_run=args.dry_run,
        )
    except Exception as e:
        log.exception("re-embed 失败: %s", e)
        return 1

    text = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(text + "\n", encoding="utf-8")
    else:
        print(text)
    log.info(
        "done collection=%s chunks=%s dry_run=%s",
        report.get("collection"),
        report.get("chunks_reembedded"),
        report.get("dry_run"),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
