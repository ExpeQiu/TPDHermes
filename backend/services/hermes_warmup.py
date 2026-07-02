"""Hermes-agent 启动预热：避免 deploy 后首次 chat 触发 lazy-install 冷启动。"""
from __future__ import annotations

import asyncio
import logging
import os

import httpx

logger = logging.getLogger("tpdx.hermes")

WARMUP_ENABLED = os.getenv("HERMES_WARMUP_ENABLED", "1").strip().lower() not in (
    "0",
    "false",
    "no",
    "off",
)
WARMUP_DELAY_SEC = float(os.getenv("HERMES_WARMUP_DELAY_SEC", "5"))
WARMUP_TIMEOUT_SEC = float(os.getenv("HERMES_WARMUP_TIMEOUT_SEC", "60"))
WARMUP_MESSAGE = os.getenv("HERMES_WARMUP_MESSAGE", "ping")


async def warmup_hermes_agent() -> None:
    if not WARMUP_ENABLED:
        logger.info("[hermes-warmup] skipped (HERMES_WARMUP_ENABLED=0)")
        return

    from backend.routes.chat import _resolve_chat_target

    target = _resolve_chat_target()
    if not target:
        logger.info("[hermes-warmup] skipped (HERMES_CHAT_API_URL not configured)")
        return

    target_url, api_key = target
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    body = {
        "model": os.getenv("HERMES_CHAT_MODEL", "hermes-agent"),
        "messages": [{"role": "user", "content": WARMUP_MESSAGE}],
        "stream": False,
    }
    timeout = httpx.Timeout(
        connect=10.0,
        read=WARMUP_TIMEOUT_SEC,
        write=10.0,
        pool=10.0,
    )
    logger.info(
        "[hermes-warmup] POST %s timeout=%ss message=%r",
        target_url,
        WARMUP_TIMEOUT_SEC,
        WARMUP_MESSAGE,
    )
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(target_url, headers=headers, json=body)
            if resp.status_code >= 400:
                logger.warning(
                    "[hermes-warmup] HTTP %s body=%s",
                    resp.status_code,
                    resp.text[:240],
                )
            else:
                logger.info("[hermes-warmup] ok status=%s", resp.status_code)
    except Exception as exc:
        logger.warning("[hermes-warmup] failed (non-fatal): %s", exc)


async def schedule_hermes_warmup() -> None:
    if WARMUP_DELAY_SEC > 0:
        await asyncio.sleep(WARMUP_DELAY_SEC)
    await warmup_hermes_agent()
