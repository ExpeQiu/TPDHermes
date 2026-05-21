#!/usr/bin/env python3
"""为硬编码深色 Tailwind 类批量追加浅色主题对应类。"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TARGET_DIRS = [ROOT / "src" / "app", ROOT / "src" / "components"]

EXACT = {
    "min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-4 text-white sm:p-6 md:p-8": (
        "min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100 p-4 text-slate-900 "
        "sm:p-6 md:p-8 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 dark:text-white"
    ),
    "relative min-h-dvh overflow-x-hidden bg-slate-950 text-slate-100": (
        "relative min-h-dvh overflow-x-hidden bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100"
    ),
    "flex min-h-screen items-center justify-center bg-slate-950 text-sm text-slate-400": (
        "flex min-h-screen items-center justify-center text-sm text-slate-500 dark:bg-slate-950 dark:text-slate-400"
    ),
    "min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 text-white p-4 sm:p-6 md:p-8": (
        "min-h-screen bg-gradient-to-br from-slate-100 to-slate-200 p-4 text-slate-900 sm:p-6 md:p-8 "
        "dark:from-slate-900 dark:to-slate-800 dark:text-white"
    ),
    "flex h-screen bg-slate-900 text-white overflow-hidden": (
        "flex h-screen overflow-hidden bg-slate-100 text-slate-900 dark:bg-slate-900 dark:text-white"
    ),
    "flex h-screen items-center justify-center bg-slate-900 text-slate-400 text-sm": (
        "flex h-screen items-center justify-center bg-slate-100 text-sm text-slate-500 "
        "dark:bg-slate-900 dark:text-slate-400"
    ),
}

# 顺序：先长后短，避免部分替换
TOKEN_REPLACEMENTS = [
    ("border-slate-800/80", "border-slate-200/80 dark:border-slate-800/80"),
    ("border-slate-800", "border-slate-200 dark:border-slate-800"),
    ("border-slate-700", "border-slate-300 dark:border-slate-700"),
    ("border-slate-600", "border-slate-300 dark:border-slate-600"),
    ("bg-slate-950/80", "bg-slate-100 dark:bg-slate-950/80"),
    ("bg-slate-950/70", "bg-slate-100 dark:bg-slate-950/70"),
    ("bg-slate-950/60", "bg-slate-100/80 dark:bg-slate-950/60"),
    ("bg-slate-950/50", "bg-slate-100/70 dark:bg-slate-950/50"),
    ("bg-slate-950/40", "bg-slate-100/60 dark:bg-slate-950/40"),
    ("bg-slate-950/30", "bg-slate-100/50 dark:bg-slate-950/30"),
    ("bg-slate-900/80", "bg-slate-100 dark:bg-slate-900/80"),
    ("bg-slate-900/70", "bg-slate-100 dark:bg-slate-900/70"),
    ("bg-slate-900/60", "bg-white/90 dark:bg-slate-900/60"),
    ("bg-slate-900/50", "bg-white/80 dark:bg-slate-900/50"),
    ("bg-slate-900/40", "bg-slate-100/80 dark:bg-slate-900/40"),
    ("bg-slate-800/80", "bg-slate-200/80 dark:bg-slate-800/80"),
    ("bg-slate-800/70", "bg-slate-200/70 dark:bg-slate-800/70"),
    ("bg-slate-800/60", "bg-slate-200/60 dark:bg-slate-800/60"),
    ("bg-slate-800/40", "bg-slate-200/40 dark:bg-slate-800/40"),
    ("bg-slate-800", "bg-slate-200 dark:bg-slate-800"),
    ("bg-slate-700/70", "bg-slate-300/70 dark:bg-slate-700/70"),
    ("bg-slate-700/60", "bg-slate-300/60 dark:bg-slate-700/60"),
    ("bg-slate-700/40", "bg-slate-300/40 dark:bg-slate-700/40"),
    ("bg-slate-700", "bg-slate-300 dark:bg-slate-700"),
    ("bg-slate-900", "bg-slate-100 dark:bg-slate-900"),
    ("bg-slate-950", "bg-slate-50 dark:bg-slate-950"),
    ("text-slate-300", "text-slate-700 dark:text-slate-300"),
    ("text-slate-200", "text-slate-800 dark:text-slate-200"),
    ("hover:bg-slate-900/80", "hover:bg-slate-200/80 dark:hover:bg-slate-900/80"),
    ("hover:bg-slate-900", "hover:bg-slate-200 dark:hover:bg-slate-900"),
    ("hover:border-slate-700", "hover:border-slate-400 dark:hover:border-slate-700"),
    ("hover:border-slate-600", "hover:border-slate-400 dark:hover:border-slate-600"),
    ("hover:text-white", "hover:text-slate-900 dark:hover:text-white"),
    ("placeholder-slate-500", "placeholder-slate-400 dark:placeholder-slate-500"),
]

SKIP_FILES = {"Layout.tsx"}


def already_themed(fragment: str, token: str) -> bool:
    prefix = token.split("/")[0].split("-")[0:3]
    # e.g. border-slate-800 -> look for dark:border-slate-800 or border-slate-200 dark:
    if "dark:" + token in fragment:
        return True
    if token.startswith("border-slate-8") and "border-slate-200" in fragment:
        return True
    if token.startswith("border-slate-7") and "border-slate-300" in fragment:
        return True
    if token.startswith("bg-slate-") and re.search(r"bg-(white|slate-50|slate-100)", fragment):
        if "dark:bg-slate-" in fragment:
            return True
    if token.startswith("text-slate-") and re.search(r"text-slate-[6789]", fragment):
        if "dark:text-slate-" in fragment:
            return True
    return False


def replace_in_class_string(class_value: str) -> str:
    updated = class_value
    for old, new in EXACT.items():
        if old in updated:
            updated = updated.replace(old, new)

    for token, replacement in TOKEN_REPLACEMENTS:
        if token not in updated:
            continue
        if already_themed(updated, token):
            continue
        updated = updated.replace(token, replacement)

    # 标题/正文 text-white（保留彩色按钮上的 text-white）
    if " text-white" in updated and "dark:text-white" not in updated:
        if not re.search(r"bg-(blue|green|red|yellow|emerald|violet|purple|sky|indigo|amber|orange)-", updated):
            updated = updated.replace(" text-white", " text-slate-900 dark:text-white")

    return updated


CLASS_ATTR_RE = re.compile(r'className=\{`([^`]*?)`\}|className="([^"]*?)"')


def transform(content: str) -> str:
    def repl(match: re.Match[str]) -> str:
        raw = match.group(1) if match.group(1) is not None else match.group(2)
        new = replace_in_class_string(raw)
        if match.group(1) is not None:
            return f"className={{`{new}`}}"
        return f'className="{new}"'

    return CLASS_ATTR_RE.sub(repl, content)


def main() -> None:
    changed_files: list[str] = []
    for base in TARGET_DIRS:
        for path in base.rglob("*.tsx"):
            if path.name in SKIP_FILES or path.name.startswith("._"):
                continue
            original = path.read_text(encoding="utf-8")
            updated = transform(original)
            if updated != original:
                path.write_text(updated, encoding="utf-8")
                changed_files.append(str(path.relative_to(ROOT)))
    print(f"Updated {len(changed_files)} files")
    for name in changed_files:
        print(f"  - {name}")


if __name__ == "__main__":
    main()
