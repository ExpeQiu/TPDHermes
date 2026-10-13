"""运行配置只读快照。密钥不出现在响应里。"""

from __future__ import annotations

import logging
import os
from typing import Any
from urllib.parse import urlparse

from backend.services.geelywiki_cli import geelywiki_root

logger = logging.getLogger("tpdx.hermes.runtime_config")


def _flag(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _public_url(url: str) -> str | None:
    raw = url.strip()
    if not raw:
        return None
    parsed = urlparse(raw)
    if not parsed.scheme or not parsed.hostname:
        return raw.split("?", 1)[0]
    port = f":{parsed.port}" if parsed.port else ""
    return f"{parsed.scheme}://{parsed.hostname}{port}{parsed.path}"


def build_runtime_config() -> dict[str, Any]:
    """当前进程读到的有效配置。尚未有页面保存行时 data_source 为 env。"""
    chat_url = _public_url(os.getenv("HERMES_CHAT_API_URL", ""))
    model = os.getenv("HERMES_CHAT_MODEL", "").strip() or "hermes-agent"
    wiki_root = str(geelywiki_root())
    payload: dict[str, Any] = {
        "module": "system-config",
        "version": "0.1.0",
        "data_source": "env",
        "mock_mode": _flag("AI_MOCK_MODE"),
        "chat": {
            "available": bool(chat_url),
            "target": chat_url,
            "model": model,
        },
        "wiki": {
            "root": wiki_root,
            "cli_override": bool(os.getenv("GEELYWIKI_CLI", "").strip()),
        },
        "warnings": [],
    }
    if not chat_url:
        payload["warnings"].append("HERMES_CHAT_API_URL 未配置，对话上游不可用")
    logger.info(
        "runtime config shown data_source=%s mock=%s chat_available=%s wiki_root=%s",
        payload["data_source"],
        payload["mock_mode"],
        payload["chat"]["available"],
        wiki_root,
    )
    return payload
