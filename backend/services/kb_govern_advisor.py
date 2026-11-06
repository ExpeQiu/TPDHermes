"""把规则无法归位的文档交给 Hermes 判断业务域和目录。模型不写库。"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

import httpx

from backend.services.kb_auto_govern import DOMAIN_ROOT_FOLDER

logger = logging.getLogger("tpdx.hermes.kb_govern_advisor")

_FENCE = re.compile(r"^```(?:json)?\s*\n([\s\S]*?)\n```$", re.IGNORECASE)


def advisor_mode() -> str:
    flag = os.getenv("AI_MOCK_MODE", "").strip().lower()
    if flag in {"1", "true", "yes", "on"}:
        return "mock"
    if not os.getenv("HERMES_CHAT_API_URL", "").strip():
        return "unavailable"
    return "hermes"


async def _agent_batch_limit() -> int:
    from backend.services.kb_govern_settings import load_schedule

    settings = await load_schedule()
    return int(settings["agent_batch"])


def parse_govern_decisions(
    text: str,
    *,
    allowed: set[str],
    pending_ids: set[str],
) -> dict[str, tuple[str, str]]:
    cleaned = text.strip()
    fenced = _FENCE.match(cleaned)
    if fenced:
        cleaned = fenced.group(1).strip()
    try:
        payload = json.loads(cleaned)
    except json.JSONDecodeError:
        return {}
    rows = payload.get("decisions") if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        return {}
    out: dict[str, tuple[str, str]] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        doc_id = str(row.get("doc_id") or "").strip()
        domain = str(row.get("domain") or "").strip()
        folder = str(row.get("folder") or "").strip().strip("/")
        if doc_id not in pending_ids or domain not in allowed or not folder:
            continue
        out[doc_id] = (domain, folder)
    return out


def mock_decisions(
    items: list[dict[str, Any]],
    eligible: list[str],
) -> dict[str, tuple[str, str]]:
    if not eligible:
        return {}
    domain = eligible[0]
    folder = DOMAIN_ROOT_FOLDER.get(domain, f"02-知识库/{domain}")
    return {str(item["doc_id"]): (domain, folder) for item in items if item.get("doc_id")}


def _prompt(items: list[dict[str, Any]], eligible: list[str]) -> tuple[str, str]:
    system = (
        "你是知识库归位助手。只能从给定业务域中选择一个 domain，并给出该文档应放入的 folder。"
        "不要改写正文。只输出 JSON：{\"decisions\":[{\"doc_id\":\"\",\"domain\":\"\",\"folder\":\"\"}]}。"
    )
    user = json.dumps({"eligible_domains": eligible, "documents": items}, ensure_ascii=False)
    return system, user


async def _ask_hermes(items: list[dict[str, Any]], eligible: list[str]) -> str:
    url = os.getenv("HERMES_CHAT_API_URL", "").strip()
    api_key = os.getenv("HERMES_CHAT_API_KEY", "").strip()
    model = os.getenv("HERMES_CHAT_MODEL", "").strip() or "hermes-agent"
    system, user = _prompt(items, eligible)
    payload = {
        "model": model,
        "stream": False,
        "max_tokens": 2048,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    timeout = httpx.Timeout(connect=10.0, read=90.0, write=30.0, pool=10.0)
    logger.info(
        "kb_govern_advisor request model=%s docs=%s",
        model,
        len(items),
    )
    async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
        resp = await client.post(url, headers=headers, json=payload)
    if resp.status_code >= 400:
        raise RuntimeError(f"llm_http_{resp.status_code}")
    data = resp.json()
    choices = data.get("choices") if isinstance(data, dict) else None
    if isinstance(choices, list) and choices:
        message = choices[0].get("message") if isinstance(choices[0], dict) else None
        content = message.get("content") if isinstance(message, dict) else None
        if isinstance(content, str) and content.strip():
            return content.strip()
    raise RuntimeError("empty_llm_response")


async def advise_placements(
    items: list[dict[str, Any]],
    eligible: list[str],
) -> tuple[dict[str, tuple[str, str]], str, str]:
    mode = advisor_mode()
    if mode == "mock":
        logger.info("kb_govern_advisor mode=mock docs=%s", len(items))
        return mock_decisions(items, eligible), mode, ""
    if mode == "unavailable":
        logger.info("kb_govern_advisor mode=unavailable docs=%s", len(items))
        return {}, mode, "hermes_unconfigured"
    allowed = set(eligible)
    accepted: dict[str, tuple[str, str]] = {}
    error = ""
    batch = await _agent_batch_limit()
    for start in range(0, len(items), batch):
        chunk = items[start : start + batch]
        pending_ids = {str(item["doc_id"]) for item in chunk}
        try:
            text = await _ask_hermes(chunk, eligible)
            accepted.update(parse_govern_decisions(text, allowed=allowed, pending_ids=pending_ids))
        except Exception as exc:
            error = str(exc)
            logger.warning(
                "kb_govern_advisor failed docs=%s error=%s",
                len(chunk),
                error,
            )
            break
    logger.info(
        "kb_govern_advisor mode=hermes requested=%s accepted=%s error=%s",
        len(items),
        len(accepted),
        error or "-",
    )
    return accepted, mode, error
