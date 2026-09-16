#!/usr/bin/env python3
"""
myKW ↔ TPDHermes 知识库双向同步（仅手动触发）。

默认 dry-run；真正写入需加 --apply。

  python3 scripts/sync_mykw_kb.py status
  python3 scripts/sync_mykw_kb.py push [--apply] [--only jlgf_tech_points]
  python3 scripts/sync_mykw_kb.py pull [--apply] [--overwrite]
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

from backend.services.mykw_kb_sync import (  # noqa: E402
    mykw_push_enabled,
    pull_from_hermes,
    push_to_hermes,
    resolve_vault_root,
    status_report,
    write_json_log,
    write_vault_log,
)

DEFAULT_OUTPUT_DIR = ROOT / "data" / "obsidian_imports" / "manifests"
DEFAULT_LOG_DIR = ROOT / "data" / "obsidian_imports" / "logs"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="myKW ↔ TPDHermes 手动双向同步")
    p.add_argument("command", choices=("status", "push", "pull"), help="status | push | pull")
    p.add_argument("--vault-root", default=os.getenv("OBSIDIAN_VAULT_ROOT", ""), help="myKW 4.Knowledge 根目录")
    p.add_argument("--chroma-url", default=os.getenv("CHROMA_HOST", "http://localhost:8001"))
    p.add_argument("--hermes-api", default=os.getenv("HERMES_API_BASE", "http://localhost:8000"))
    p.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR))
    p.add_argument("--log-dir", default=str(DEFAULT_LOG_DIR))
    p.add_argument("--apply", action="store_true", help="真正写入；缺省为预览")
    p.add_argument(
        "--force-push",
        action="store_true",
        help="允许 myKW→Chroma 直推（默认关闭；内部知识走 GeelyWiki）",
    )
    p.add_argument("--overwrite", action="store_true", help="pull 时覆盖已有回写笔记")
    p.add_argument("--sync-cache", action="store_true", help="push --apply 后触发 kb_cache sync")
    p.add_argument("--only", action="append", default=[], help="push 仅指定 target 名，可重复")
    p.add_argument("--collection", action="append", default=[], help="pull 仅指定 collection，可重复")
    p.add_argument("--project-id", default="__all__")
    return p.parse_args()


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    args = parse_args()
    vault = resolve_vault_root(args.vault_root or None)
    if not vault.is_dir():
        print(f"vault 不存在: {vault}", file=sys.stderr)
        return 2

    if args.command == "status":
        report = status_report(vault, chroma_url=args.chroma_url, only=args.only or None)
    elif args.command == "push":
        report = push_to_hermes(
            vault,
            chroma_url=args.chroma_url,
            output_dir=Path(args.output_dir),
            apply=args.apply,
            only=args.only or None,
            sync_cache=args.sync_cache,
            hermes_api=args.hermes_api,
            project_id=args.project_id,
            allow_push=bool(args.force_push or mykw_push_enabled()),
        )
    else:
        report = pull_from_hermes(
            vault,
            chroma_url=args.chroma_url,
            apply=args.apply,
            overwrite=args.overwrite,
            only_collections=args.collection or None,
        )

    log_path = write_json_log(report, Path(args.log_dir))
    vault_log = write_vault_log(vault, report)
    report["log_path"] = str(log_path)
    if vault_log:
        report["vault_log"] = str(vault_log)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if report.get("ok") is False:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
