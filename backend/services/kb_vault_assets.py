"""
Obsidian Vault 内嵌资源解析与只读访问（供知识库 Markdown 图片等使用）。
"""

from __future__ import annotations

import logging
import mimetypes
import os
from pathlib import Path
from urllib.parse import unquote

from fastapi import HTTPException
from fastapi.responses import FileResponse

logger = logging.getLogger("tpdx.hermes")

DEFAULT_VAULT_ROOT = (
    "/Users/expeqiu/Library/Mobile Documents/iCloud~md~obsidian/Documents/expe/myKW/4.Knowledge"
)


def get_obsidian_vault_root() -> Path | None:
    raw = os.getenv("OBSIDIAN_VAULT_ROOT", DEFAULT_VAULT_ROOT).strip()
    if not raw:
        return None
    root = Path(raw).expanduser().resolve()
    if not root.is_dir():
        logger.warning("OBSIDIAN_VAULT_ROOT not a directory: %s", root)
        return None
    return root


def _normalize_asset_ref(raw: str) -> str:
    ref = unquote(raw or "").strip()
    if ref.startswith("<") and ref.endswith(">"):
        ref = ref[1:-1].strip()
    return ref.lstrip("./")


def _resolve_under_vault(vault_root: Path, relative: str) -> Path | None:
    rel = _normalize_asset_ref(relative).replace("\\", "/").lstrip("/")
    if not rel or rel.startswith("http://") or rel.startswith("https://"):
        return None
    if ".." in rel.split("/"):
        return None
    candidate = (vault_root / rel).resolve()
    try:
        candidate.relative_to(vault_root.resolve())
    except ValueError:
        return None
    if candidate.is_file():
        return candidate
    return None


def resolve_vault_asset_path(
    asset_path: str,
    *,
    note_folder: str | None = None,
    source_vault_file: str | None = None,
) -> Path | None:
    """
    解析 Obsidian 笔记中的相对资源路径。
    优先：相对 source_vault_file 所在目录 → note_folder → Vault 根。
    """
    vault_root = get_obsidian_vault_root()
    if vault_root is None:
        return None

    ref = _normalize_asset_ref(asset_path)
    if not ref:
        return None
    if ref.startswith("http://") or ref.startswith("https://") or ref.startswith("data:"):
        return None
    if ref.startswith("/"):
        return _resolve_under_vault(vault_root, ref.lstrip("/"))

    note_dir = ""
    if source_vault_file:
        sf = _normalize_asset_ref(source_vault_file).replace("\\", "/")
        if "/" in sf:
            note_dir = sf.rsplit("/", 1)[0]
    if not note_dir and note_folder:
        note_dir = _normalize_asset_ref(note_folder).replace("\\", "/").strip("/")

    candidates: list[str] = []
    if note_dir:
        candidates.append(f"{note_dir}/{ref}")
    candidates.append(ref)

    seen: set[str] = set()
    for rel in candidates:
        if rel in seen:
            continue
        seen.add(rel)
        hit = _resolve_under_vault(vault_root, rel)
        if hit is not None:
            return hit
    return None


def vault_relative_file(absolute_file: Path) -> str:
    vault_root = get_obsidian_vault_root()
    if vault_root is None:
        return ""
    try:
        return absolute_file.resolve().relative_to(vault_root.resolve()).as_posix()
    except ValueError:
        return ""


def serve_vault_asset(
    asset_path: str,
    *,
    note_folder: str | None = None,
    source_vault_file: str | None = None,
) -> FileResponse:
    resolved = resolve_vault_asset_path(
        asset_path,
        note_folder=note_folder,
        source_vault_file=source_vault_file,
    )
    if resolved is None:
        logger.info(
            "vault_asset miss path=%r note_folder=%r source_vault_file=%r",
            asset_path,
            note_folder,
            source_vault_file,
        )
        raise HTTPException(status_code=404, detail="Vault asset not found")

    media_type, _ = mimetypes.guess_type(str(resolved))
    return FileResponse(
        path=resolved,
        media_type=media_type or "application/octet-stream",
        filename=resolved.name,
    )
