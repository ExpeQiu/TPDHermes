#!/usr/bin/env python3
"""从本地 ZIP 批量恢复技能包到 skills/，并补齐 __init__.py。"""

from __future__ import annotations

import argparse
import logging
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.services.skill_lifecycle import resolve_zip_package_root, safe_extract_zip, _iter_extract_root_children
from backend.services.skill_package import (
    STANDARD_INIT_PY_TEMPLATE,
    _skill_class_name,
    ensure_python_stub,
)

logger = logging.getLogger("batch_restore_skills")


def _resolve_package_root(extract_root: Path, zip_stem: str) -> tuple[Path, str]:
    """解析 ZIP 包根目录；多顶层项时优先匹配 zip 文件名的 SKILL.md 目录。"""
    try:
        pack, name = resolve_zip_package_root(extract_root)
        if name:
            return pack, name
        return pack, zip_stem
    except ValueError:
        pass

    children = [p for p in _iter_extract_root_children(extract_root) if p.is_dir()]
    preferred = extract_root / zip_stem
    if preferred.is_dir() and (preferred / "SKILL.md").is_file():
        return preferred, zip_stem

    for child in children:
        if (child / "SKILL.md").is_file():
            return child, child.name

    raise ValueError(
        f"无法解析技能包根目录（zip={zip_stem}），"
        "须含单一顶层目录且内含 SKILL.md 或 __init__.py"
    )


def _merge_copy(src: Path, dest: Path, preserve_init: bool) -> None:
    """将技能包内容合并到目标目录；可选保留已有 __init__.py。"""
    dest.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        if item.name == "__MACOSX":
            continue
        if preserve_init and item.name == "__init__.py":
            continue
        target = dest / item.name
        if item.is_dir():
            if target.exists() and target.is_dir():
                _merge_copy(item, target, preserve_init=False)
            else:
                if target.exists():
                    shutil.rmtree(target)
                shutil.copytree(item, target)
        else:
            shutil.copy2(item, target)


def _ensure_script_init(dest: Path, skill_name: str) -> bool:
    """有 scripts/generate_*.py 时用脚本渲染版 __init__.py（覆盖纯透传桩）。"""
    if not list((dest / "scripts").glob("generate_*.py")):
        return False
    init_py = dest / "__init__.py"
    if init_py.is_file() and "generate_content_from_scripts" in init_py.read_text(encoding="utf-8"):
        return False
    body = STANDARD_INIT_PY_TEMPLATE.format(
        skill_name=skill_name,
        class_name=_skill_class_name(skill_name),
    )
    init_py.write_text(body, encoding="utf-8")
    logger.info("script init patched name=%s", skill_name)
    return True


def restore_zip(zip_path: Path, skills_root: Path) -> dict:
    zip_path = zip_path.resolve()
    with tempfile.TemporaryDirectory(prefix="skill_restore_") as tmp:
        extract_root = Path(tmp)
        with zipfile.ZipFile(zip_path, "r") as zf:
            safe_extract_zip(zf, extract_root)
        package_root, skill_name = _resolve_package_root(extract_root, zip_path.stem)

        dest = skills_root / skill_name
        had_init = (dest / "__init__.py").is_file()
        before_files = set(dest.rglob("*")) if dest.is_dir() else set()

        _merge_copy(package_root, dest, preserve_init=had_init)

        stub_created = ensure_python_stub(dest, skill_name)
        script_init = _ensure_script_init(dest, skill_name)
        has_init = (dest / "__init__.py").is_file()
        has_skill_md = (dest / "SKILL.md").is_file()

        after_files = set(dest.rglob("*"))
        added = len(after_files - before_files)

        return {
            "zip": zip_path.name,
            "skill_name": skill_name,
            "had_init_before": had_init,
            "stub_created": stub_created,
            "script_init": script_init,
            "has_init": has_init,
            "has_skill_md": has_skill_md,
            "files_added": added,
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="从 ZIP 批量恢复技能包")
    parser.add_argument(
        "--zip-dir",
        default="/Users/expeqiu/Downloads/Skills",
        help="包含 *.zip 的目录",
    )
    parser.add_argument(
        "--skills-root",
        default=str(ROOT / "skills"),
        help="skills 根目录",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
    )

    zip_dir = Path(args.zip_dir)
    skills_root = Path(args.skills_root)
    skills_root.mkdir(parents=True, exist_ok=True)

    zips = sorted(zip_dir.glob("*.zip"))
    if not zips:
        logger.error("未找到 ZIP: %s", zip_dir)
        return 1

    ok, fail = 0, 0
    for zp in zips:
        try:
            info = restore_zip(zp, skills_root)
            logger.info(
                "OK %s -> %s init=%s stub=%s skill_md=%s added=%s",
                info["zip"],
                info["skill_name"],
                info["has_init"],
                info["stub_created"],
                info["has_skill_md"],
                info["files_added"],
            )
            ok += 1
        except Exception as e:
            logger.error("FAIL %s: %s", zp.name, e)
            fail += 1

    logger.info("done total=%s ok=%s fail=%s", len(zips), ok, fail)
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
