#!/usr/bin/env python3
"""
经 GeelyWiki CLI 拉取知识更新并归档到 TPDHermes（Chroma + 可选图谱）。

默认走 CLI：

  python3 scripts/ingest_geelywiki.py --from-cli --apply --graph
  python3 scripts/ingest_geelywiki.py --from-cli --demo          # 离线契约

仍可用 --pages-json 读构建产物（无 CLI 时的回退）。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.services.geelywiki_ingest import (  # noqa: E402
    apply_geelywiki_graph,
    ingest_geelywiki,
)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="GeelyWiki CLI → Hermes LLMwiki 入库")
    p.add_argument("--from-cli", action="store_true", help="经 geelywiki pages export 拉更新（推荐）")
    p.add_argument("--demo", action="store_true", help="调用 geelywiki --demo，不读盘")
    p.add_argument("--pages-json", default=os.getenv("GEELYWIKI_PAGES_JSON", ""), help="回退：直接读 pages.json")
    p.add_argument("--geelywiki-root", default=os.getenv("GEELYWIKI_ROOT", ""))
    p.add_argument("--archive-root", default=os.getenv("GEELYWIKI_ARCHIVE_ROOT", ""))
    p.add_argument("--chroma-url", default=os.getenv("CHROMA_HOST", "http://localhost:8001"))
    p.add_argument("--apply", action="store_true", help="写入 Chroma；缺省为预览")
    p.add_argument("--graph", action="store_true", help="入库后写入 SQLite KG")
    return p.parse_args()


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    args = parse_args()
    if args.geelywiki_root:
        os.environ["GEELYWIKI_ROOT"] = args.geelywiki_root
    from_cli = bool(args.from_cli or args.demo or not args.pages_json)
    report = ingest_geelywiki(
        pages_json=Path(args.pages_json) if args.pages_json and not from_cli else None,
        archive_root=Path(args.archive_root) if args.archive_root else None,
        chroma_url=args.chroma_url,
        apply=args.apply,
        from_cli=from_cli,
        demo=args.demo,
    )
    if args.graph and report.get("ok") and report.get("kg_bundle"):
        report["kg"] = asyncio.run(apply_geelywiki_graph(report["kg_bundle"]))
    printable = dict(report)
    bundle = printable.get("kg_bundle")
    if isinstance(bundle, dict):
        printable["kg_bundle"] = {k: len(v) if isinstance(v, list) else v for k, v in bundle.items()}
    print(json.dumps(printable, ensure_ascii=False, indent=2))
    if report.get("ok") is False:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
