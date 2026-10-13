"""Agent 通过 CLI 连接本系统时的接入 Token。日志只记结果，不记原文。"""

from __future__ import annotations

import logging
import secrets
from typing import Any

from tpdhermes.capabilities import public_config, resolve_token

logger = logging.getLogger("tpdx.hermes.cli_token")

MIN_TOKEN_LEN = 16
AGENT_CLIENT_HEADER = "X-TPDHermes-Client"
AGENT_TOKEN_HEADER = "X-TPDHermes-Agent-Token"


def _format_reason(raw: str) -> str | None:
    if any(char.isspace() for char in raw):
        return "Token 不能包含空白"
    if len(raw) < MIN_TOKEN_LEN:
        return "Token 至少 16 位，供其他 Agent 通过 CLI 连接并执行指令"
    return None


def verify_access_token(token: str | None) -> dict[str, Any]:
    """校验候选 Token，或在未传入时确认当前是否已允许 Agent 接入。"""
    raw = (token or "").strip()
    expected = resolve_token()
    source = public_config().get("token_source") or "none"
    if not raw:
        if expected:
            logger.info("cli token verify ok=true source=%s mode=configured", source)
            return {"ok": True, "reason": None, "source": source, "can_execute": True}
        logger.info("cli token verify ok=false reason=unset")
        return {
            "ok": False,
            "reason": "未设置接入 Token，其他 Agent 无法通过 CLI 执行指令",
            "source": "none",
            "can_execute": False,
        }
    reason = _format_reason(raw)
    if reason:
        logger.info("cli token verify ok=false reason=format")
        return {"ok": False, "reason": reason, "source": None, "can_execute": False}
    if expected and len(raw) == len(expected) and secrets.compare_digest(raw, expected):
        logger.info("cli token verify ok=true source=%s mode=match", source)
        return {"ok": True, "reason": None, "source": source, "can_execute": True}
    if expected:
        logger.info("cli token verify ok=true source=new mode=replace")
        return {
            "ok": True,
            "reason": "保存后将替换当前接入 Token，其他 Agent 需改用新 Token 才能执行指令",
            "source": "new",
            "can_execute": False,
        }
    logger.info("cli token verify ok=true source=new")
    return {"ok": True, "reason": None, "source": "new", "can_execute": False}


def accept_agent_token(token: str | None) -> dict[str, Any]:
    """保存前只检查能否作为 Agent 接入 Token，不要求与旧值相同。"""
    raw = (token or "").strip()
    reason = _format_reason(raw) if raw else "未填写 Token"
    if reason:
        logger.info("cli token accept ok=false")
        return {"ok": False, "reason": reason}
    logger.info("cli token accept ok=true")
    return {"ok": True, "reason": None}


def authorize_cli_request(token: str | None) -> dict[str, Any]:
    """其他 Agent 携带 Token 执行指令时的准入。"""
    expected = resolve_token()
    if not expected:
        logger.info("cli agent auth ok=false reason=unset")
        return {"ok": False, "reason": "未设置 Agent 接入 Token，无法通过 CLI 执行指令"}
    raw = (token or "").strip()
    if raw and len(raw) == len(expected) and secrets.compare_digest(raw, expected):
        logger.info("cli agent auth ok=true")
        return {"ok": True, "reason": None}
    logger.info("cli agent auth ok=false reason=rejected")
    return {"ok": False, "reason": "Token 无效，无法通过 CLI 执行指令"}
