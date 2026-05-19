"""统一推导 user_id（请求体 / Query / X-User-ID、飞书会话、IP+UA 匿名）。"""
from __future__ import annotations

import hashlib
import logging
import os
from typing import Optional

from fastapi import Query, Request

from backend.services.feishu_auth import get_user_session

logger = logging.getLogger("tpdx.hermes.user_identity")

GLOBAL_ADMIN_ENV = "TPDHERMES_GLOBAL_ADMIN_USER_IDS"


def normalize_user_id(value: str | None) -> str:
    if value is None:
        return "default"
    s = str(value).strip()
    return s if s else "default"


def derive_user_id(request: Request | None, provided_user_id: str | None = None) -> str:
    """显式 provided 优先；否则用 IP+UA 生成 auto_ 指纹（与 TPD-skill-platform 一致）。"""
    if provided_user_id is not None:
        stripped = provided_user_id.strip()
        if stripped.lower() == "default":
            return "default"
        return stripped
    try:
        headers = request.headers if request else {}
        xff = str(headers.get("x-forwarded-for") or "").strip()
        xreal = str(headers.get("x-real-ip") or "").strip()
        ip = ""
        if xff:
            ip = xff.split(",")[0].strip()
        if not ip:
            client_host = ""
            if request and getattr(request, "client", None):
                client_host = str(getattr(request.client, "host", "") or "")
            ip = xreal or client_host
        ua = str(headers.get("user-agent") or "").strip()
        fp = f"{ip}|{ua}"
        digest = hashlib.sha256(fp.encode("utf-8", errors="ignore")).hexdigest()[:16]
        return f"auto_{digest}"
    except Exception as e:
        logger.warning("derive_user_id failed, fallback to default: %s", e)
        return "default"


def feishu_effective_user_id(request: Request | None) -> str | None:
    """从 X-Feishu-Session-Token 或 Cookie 解析 feishu:{open_id}。"""
    if request is None:
        return None
    token = (
        request.headers.get("X-Feishu-Session-Token") or request.headers.get("x-feishu-session-token") or ""
    ).strip()
    if not token:
        token = (
            request.cookies.get("tphermes_feishu_session") or request.cookies.get("tphermes_session") or ""
        ).strip()
    if not token:
        return None
    user = get_user_session(token)
    if not user or not (user.open_id or "").strip():
        return None
    return f"feishu:{user.open_id.strip()}"


def effective_user_id_for_api(
    request: Request,
    *,
    query_user_id: str | None = None,
    body_user_id: str | None = None,
) -> str:
    """
    优先级：请求体 user_id > Query user_id > X-User-ID > 飞书会话 > IP+UA。
    """
    for cand in (body_user_id, query_user_id):
        if cand is not None and str(cand).strip():
            return normalize_user_id(str(cand).strip())
    header_uid = (request.headers.get("X-User-ID") or request.headers.get("x-user-id") or "").strip()
    if header_uid:
        return normalize_user_id(header_uid)
    fs = feishu_effective_user_id(request)
    if fs:
        return fs
    return derive_user_id(request, None)


def viewer_role(request: Request | None) -> str:
    if request is None:
        return os.getenv("TPDHERMES_DEFAULT_USER_ROLE", "tenant_admin")
    r = (request.headers.get("X-User-Role") or request.headers.get("x-user-role") or "").strip()
    return r or os.getenv("TPDHERMES_DEFAULT_USER_ROLE", "tenant_admin")


def is_global_admin_user(user_id: str) -> bool:
    raw = os.getenv(GLOBAL_ADMIN_ENV, "")
    ids = {x.strip() for x in raw.split(",") if x.strip()}
    return normalize_user_id(user_id) in ids


def get_effective_user_id(
    request: Request,
    user_id: Optional[str] = Query(None, description="显式用户 ID（调试或兼容）"),
) -> str:
    return effective_user_id_for_api(request, query_user_id=user_id)
