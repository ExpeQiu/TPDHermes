#!/usr/bin/env python3
"""
将 Obsidian Vault 下的 Markdown 文档转换为 TPDHermes 可导入的 manifest。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import unicodedata
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_VAULT_ROOT = Path(
    "/Users/expeqiu/Library/Mobile Documents/iCloud~md~obsidian/Documents/expe/myKW/4.Knowledge"
)
DEFAULT_OUTPUT_DIR = ROOT / "data" / "obsidian_imports" / "manifests"


@dataclass(frozen=True)
class ImportTarget:
    name: str
    relative_dir: str
    collection: str
    domain: str
    tags: list[str]
    published: bool = True
    language: str = "zh"
    source: str = "obsidian_import"
    source_type: str = "file"
    include_files: tuple[str, ...] = ()
    exclude_files: tuple[str, ...] = ()
    title_overrides: dict[str, str] | None = None


TARGETS: tuple[ImportTarget, ...] = (
    ImportTarget(
        name="auto_company_strategy",
        relative_dir="01-汽车信息库/车企战略",
        collection="public.public_intel.auto_company_strategy",
        domain="public_intel",
        tags=["汽车信息库", "车企战略"],
    ),
    ImportTarget(
        name="vehicle_model_library",
        relative_dir="01-汽车信息库/车型库",
        collection="public.public_intel.vehicle_model_library",
        domain="public_intel",
        tags=["汽车信息库", "车型库"],
    ),
    ImportTarget(
        name="geely_tech_knowledge",
        relative_dir="02-知识库/吉利技术知识库",
        collection="public.structured_tech.geely_tech",
        domain="public_intel",
        tags=["公开情报", "技术库", "互联网检索"],
        source="web_retrieval",
        source_type="web",
        exclude_files=("JLGF.md",),
    ),
    ImportTarget(
        name="jlgf_tech_points",
        relative_dir="02-知识库/吉利技术知识库",
        collection="internal.structured_tech.tech_points",
        domain="structured_tech",
        tags=["内部知识库", "技术点", "JLGF"],
        include_files=("JLGF.md",),
        title_overrides={"JLGF.md": "吉利核心技术信息参考（JLGF）"},
    ),
    ImportTarget(
        name="release_speeches",
        relative_dir="03-发布成果",
        collection="public.release_assets.speeches",
        domain="release_assets",
        tags=["发布成果", "发言稿"],
    ),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Build Obsidian manifests for TPDHermes KB import")
    parser.add_argument("--vault-root", default=str(DEFAULT_VAULT_ROOT), help="Obsidian 知识库根目录")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR), help="manifest 输出目录")
    parser.add_argument(
        "--batch-prefix",
        default="obsidian_import",
        help="batch_id 前缀",
    )
    return parser.parse_args()


def slugify_ascii(text: str) -> str:
    normalized = unicodedata.normalize("NFKD", text)
    ascii_text = normalized.encode("ascii", "ignore").decode("ascii")
    cleaned = re.sub(r"[^A-Za-z0-9]+", "_", ascii_text).strip("_").lower()
    return cleaned or "doc"


def stable_doc_id(target_name: str, relative_path: Path) -> str:
    digest = hashlib.sha1(relative_path.as_posix().encode("utf-8")).hexdigest()[:12]
    stem_slug = slugify_ascii(relative_path.stem)[:32]
    return f"obs_{target_name}_{stem_slug}_{digest}"


def extract_title(path: Path) -> str:
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for _ in range(120):
                line = handle.readline()
                if not line:
                    break
                stripped = line.strip()
                if stripped.startswith("#"):
                    heading = stripped.lstrip("#").strip()
                    if heading:
                        return heading
    except OSError:
        pass
    return path.stem


def derive_tags(target: ImportTarget, relative_file: Path) -> list[str]:
    derived = list(target.tags)
    for part in relative_file.parent.parts:
        part = part.strip()
        if not part or part == ".":
            continue
        if part not in derived:
            derived.append(part)
    return derived


def build_document_entry(
    vault_root: Path,
    target: ImportTarget,
    source_root: Path,
    file_path: Path,
) -> dict[str, Any]:
    relative_to_target = file_path.relative_to(source_root)
    relative_to_vault = file_path.relative_to(vault_root)
    folder_base = Path(target.relative_dir)
    parent = relative_to_target.parent
    if str(parent) == ".":
        folder_path = folder_base.as_posix()
    else:
        folder_path = (folder_base / parent).as_posix()
    return {
        "doc_id": stable_doc_id(target.name, relative_to_vault),
        "file_path": str(file_path),
        "title": extract_title(file_path),
        "folder_path": folder_path,
        "tags": derive_tags(target, relative_to_target),
        "source_url": "",
    }


def build_manifest(
    vault_root: Path,
    output_dir: Path,
    batch_prefix: str,
    target: ImportTarget,
) -> dict[str, Any]:
    source_root = vault_root / target.relative_dir
    if not source_root.is_dir():
        raise FileNotFoundError(f"目录不存在: {source_root}")

    if target.include_files:
        documents = []
        for rel_name in target.include_files:
            file_path = source_root / rel_name
            if not file_path.is_file():
                raise FileNotFoundError(f"指定文件不存在: {file_path}")
            entry = build_document_entry(vault_root, target, source_root, file_path)
            override_title = (target.title_overrides or {}).get(rel_name)
            if override_title:
                entry["title"] = override_title
            documents.append(entry)
        documents.sort(key=lambda item: str(item.get("file_path") or ""))
    else:
        excluded = set(target.exclude_files)
        documents = [
            build_document_entry(vault_root, target, source_root, path)
            for path in sorted(source_root.rglob("*.md"))
            if path.is_file()
            and path.relative_to(source_root).as_posix() not in excluded
        ]
    if not documents:
        raise ValueError(f"目录下未找到 Markdown 文件: {source_root}")

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    batch_id = f"{batch_prefix}_{target.name}_{timestamp}"
    manifest = {
        "batch_id": batch_id,
        "collection": target.collection,
        "defaults": {
            "domain": target.domain,
            "folder_path": target.relative_dir,
            "published": target.published,
            "source": target.source,
            "source_type": target.source_type,
            "language": target.language,
            "tags": target.tags,
        },
        "documents": documents,
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{target.name}.manifest.json"
    output_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    return {
        "name": target.name,
        "collection": target.collection,
        "document_count": len(documents),
        "source_root": str(source_root),
        "manifest_path": str(output_path),
        "config": asdict(target),
    }


def main() -> int:
    args = parse_args()
    vault_root = Path(args.vault_root).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    if not vault_root.is_dir():
        raise SystemExit(f"vault 根目录不存在: {vault_root}")

    summaries = [
        build_manifest(vault_root, output_dir, args.batch_prefix, target)
        for target in TARGETS
    ]
    index = {
        "vault_root": str(vault_root),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "targets": summaries,
    }
    index_path = output_dir / "manifest_index.json"
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(index, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
