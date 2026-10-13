"""绑定单次运行的 MCP 执行凭证。库内只存哈希与过期时间。"""

from __future__ import annotations

import hashlib
import os
import secrets
from datetime import datetime, timedelta, timezone


def grant_ttl_seconds() -> int:
    raw = os.getenv("EXEC_GRANT_TTL_SEC", "7200").strip()
    try:
        ttl = int(raw)
    except ValueError:
        return 7200
    return max(60, ttl)


def issue_execution_grant() -> tuple[str, str, str]:
    """返回 (明文凭证, sha256, 过期时间 ISO)。明文只交给当次编排指引。"""
    token = secrets.token_urlsafe(32)
    digest = hashlib.sha256(token.encode()).hexdigest()
    expires = (datetime.now(timezone.utc) + timedelta(seconds=grant_ttl_seconds())).isoformat()
    return token, digest, expires


def execution_grant_matches(
    stored_hash: str | None,
    expires_at: str | None,
    presented: str | None,
) -> str | None:
    """匹配则返回 None，否则返回可展示的拒绝原因。不记录明文凭证。"""
    expected = str(stored_hash or "").strip()
    if not expected:
        return "运行未签发执行凭证"
    token = str(presented or "").strip()
    if not token:
        return "缺少执行凭证"
    digest = hashlib.sha256(token.encode()).hexdigest()
    if not secrets.compare_digest(digest, expected):
        return "执行凭证无效"
    raw_exp = str(expires_at or "").strip()
    if not raw_exp:
        return "执行凭证无效"
    try:
        exp = datetime.fromisoformat(raw_exp)
    except ValueError:
        return "执行凭证无效"
    if exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)
    if datetime.now(timezone.utc) >= exp:
        return "执行凭证已过期"
    return None
