"""Obsidian Vault 资源路径解析"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.services import kb_vault_assets as vault


def test_resolve_vault_asset_note_relative_then_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    vault_root = tmp_path / "vault"
    note_dir = vault_root / "02-notes/sub"
    attach = vault_root / "综合附件区/附件"
    note_dir.mkdir(parents=True)
    attach.mkdir(parents=True)
    img = attach / "Pasted image.png"
    img.write_bytes(b"\x89PNG\r\n")

    monkeypatch.setenv("OBSIDIAN_VAULT_ROOT", str(vault_root))

    hit = vault.resolve_vault_asset_path(
        "综合附件区/附件/Pasted image.png",
        note_folder="02-notes/sub",
    )
    assert hit == img.resolve()

    miss = vault.resolve_vault_asset_path("../../etc/passwd", note_folder="02-notes/sub")
    assert miss is None


def test_vault_relative_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    vault_root = tmp_path / "vault"
    md = vault_root / "a/b.md"
    md.parent.mkdir(parents=True)
    md.write_text("# hi", encoding="utf-8")
    monkeypatch.setenv("OBSIDIAN_VAULT_ROOT", str(vault_root))
    assert vault.vault_relative_file(md) == "a/b.md"
