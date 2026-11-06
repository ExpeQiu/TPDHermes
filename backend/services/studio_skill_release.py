"""场景创作技能卡释放：未保存时只开放已接入工作区的卡片。"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

logger = logging.getLogger("tpdx.hermes.studio_skill_release")

CATALOG_PATH = Path(__file__).resolve().parents[2] / "shared" / "studio-skills.json"


def catalog() -> list[dict[str, Any]]:
    raw = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise RuntimeError("studio skill catalog is not a list")
    return [row for row in raw if isinstance(row, dict) and isinstance(row.get("id"), str)]


def _ids() -> set[str]:
    return {row["id"] for row in catalog()}


def default_released(row: dict[str, Any]) -> bool:
    return row.get("status") == "ready"


def config_path() -> Path:
    override = (os.getenv("TPDHERMES_STUDIO_SKILLS_CONFIG") or "").strip()
    if override:
        return Path(override).expanduser()
    return Path.home() / "Library/Application Support/tphermes/studio-skills.json"


def _read_flags() -> dict[str, bool] | None:
    path = config_path()
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("studio skill release unreadable path=%s err=%s", path, exc)
        return None
    if not isinstance(raw, dict):
        return None
    released = raw.get("released")
    if not isinstance(released, dict):
        return {}
    known = _ids()
    return {str(key): bool(value) for key, value in released.items() if str(key) in known and isinstance(value, bool)}


def public_release() -> dict[str, Any]:
    saved = _read_flags()
    source = "saved" if saved is not None else "default"
    flags = saved or {}
    skills = []
    for row in catalog():
        released = flags[row["id"]] if row["id"] in flags else default_released(row)
        skills.append({**row, "released": released})
    return {"data_source": source, "skills": skills}


def save_release(released: dict[str, Any]) -> dict[str, Any]:
    known = _ids()
    unknown = [key for key in released if key not in known]
    if unknown:
        raise ValueError(f"未知技能卡: {', '.join(unknown)}")
    current = _read_flags() or {}
    merged = {row["id"]: current.get(row["id"], default_released(row)) for row in catalog()}
    for key, value in released.items():
        if isinstance(value, bool):
            merged[key] = value
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    document = {"released": merged}
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)
    open_ids = [key for key, flag in merged.items() if flag]
    logger.info(
        "studio skill release saved path=%s open_count=%s open_ids=%s",
        path,
        len(open_ids),
        ",".join(open_ids),
    )
    return public_release()
