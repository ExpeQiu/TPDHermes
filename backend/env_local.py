"""加载项目根目录 .env.local / .env（不覆盖已有环境变量）。"""
from __future__ import annotations

import logging
import os
import re
from pathlib import Path

logger = logging.getLogger("tpdx.hermes")

_LINE_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$")
_loaded = False


def _parse_value(raw: str) -> str:
    val = raw.strip()
    if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
        return val[1:-1]
    return val


def load_project_env(*, force: bool = False) -> None:
    global _loaded
    if _loaded and not force:
        return
    root = Path(__file__).resolve().parent.parent
    loaded_keys: list[str] = []
    for name in (".env.local", ".env"):
        path = root / name
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError as exc:
            logger.warning("env load skipped path=%s err=%s", path, exc)
            continue
        for raw_line in text.splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[len("export ") :].strip()
            m = _LINE_RE.match(line)
            if not m:
                continue
            key, val = m.group(1), _parse_value(m.group(2))
            if key in os.environ and os.environ.get(key, "").strip():
                continue
            os.environ[key] = val
            loaded_keys.append(key)
        if loaded_keys:
            logger.info("env loaded from %s keys=%s", path.name, ",".join(sorted(set(loaded_keys))))
    _loaded = True
