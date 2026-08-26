#!/usr/bin/env python3
"""
将 Obsidian Vault 下的 Markdown 文档转换为 TPDHermes 可导入的 manifest。
目录契约见 backend.services.mykw_kb_sync.TARGETS。
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.services.mykw_kb_sync import (  # noqa: E402
    DEFAULT_VAULT_ROOT,
    TARGETS,
    build_manifest,
    resolve_vault_root,
)

DEFAULT_OUTPUT_DIR = ROOT / "data" / "obsidian_imports" / "manifests"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build Obsidian manifests for TPDHermes KB import")
    parser.add_argument("--vault-root", default=str(DEFAULT_VAULT_ROOT), help="Obsidian 知识库根目录")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR), help="manifest 输出目录")
    parser.add_argument("--batch-prefix", default="obsidian_import", help="batch_id 前缀")
    parser.add_argument(
        "--skip-missing",
        action="store_true",
        default=True,
        help="目录不存在时跳过（默认开启，适配三库搬家后的缺目录）",
    )
    parser.add_argument("--no-skip-missing", action="store_false", dest="skip_missing")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    vault_root = resolve_vault_root(args.vault_root)
    output_dir = Path(args.output_dir).expanduser().resolve()
    if not vault_root.is_dir():
        raise SystemExit(f"vault 根目录不存在: {vault_root}")

    summaries = []
    for target in TARGETS:
        item = build_manifest(
            vault_root,
            output_dir,
            args.batch_prefix,
            target,
            skip_missing=args.skip_missing,
        )
        if item:
            summaries.append(item)
    index = {
        "vault_root": str(vault_root),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "targets": summaries,
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    index_path = output_dir / "manifest_index.json"
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(index, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
