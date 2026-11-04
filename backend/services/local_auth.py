"""用户名密码注册与登录。会话是签名令牌，身份解析不查库。"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import time
import uuid
from typing import Any

from fastapi import HTTPException, Request
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.local_account import LocalAccount
from backend.services.user_preference_service import (
    PREF_KEY_DISPLAY_NAME,
    PREF_KEY_EMPLOYEE_ID,
    PREF_KEY_ORG_ID,
    PREF_KEY_UNIFIED_USER_ID,
    set_platform_role,
    set_user_preferences,
)

logger = logging.getLogger("tpdx.hermes.local_auth")

LOCAL_SESSION_HEADER = "X-Local-Session-Token"
LOCAL_SESSION_COOKIE = "tphermes_local_session"
SESSION_TTL_SECONDS = 14 * 24 * 60 * 60
_USERNAME_RE = re.compile(r"^[A-Za-z0-9_\-\u4e00-\u9fff]{2,32}$")
_CODE_RE = re.compile(r"^[A-Za-z0-9_\-]{1,32}$")
DEFAULT_INITIAL_PASSWORD = "geely123"
DEFAULT_ROLE = "tenant_partner"
_DEV_SECRET = "tpdhermes-local-auth-dev"


def _secret() -> bytes:
    raw = os.getenv("TPDHERMES_LOCAL_AUTH_SECRET", "").strip() or _DEV_SECRET
    return raw.encode("utf-8")


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _b64decode(data: str) -> bytes:
    pad = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + pad)


def normalize_username(value: str) -> str:
    return (value or "").strip().lower()


def normalize_code(value: str) -> str:
    return (value or "").strip()


def validate_credentials(username: str, password: str, display_name: str | None = None) -> tuple[str, str, str]:
    name = normalize_username(username)
    if not _USERNAME_RE.match(name):
        raise HTTPException(status_code=400, detail="用户名需为 2–32 位字母、数字、下划线或中文")
    secret = (password or "").strip() or DEFAULT_INITIAL_PASSWORD
    if len(secret) < 6 or len(secret) > 64:
        raise HTTPException(status_code=400, detail="密码长度需为 6–64 位")
    shown = (display_name or "").strip() or name
    if len(shown) > 32:
        raise HTTPException(status_code=400, detail="显示名称不超过 32 个字")
    return name, secret, shown


def validate_org_codes(employee_id: str, org_id: str) -> tuple[str, str]:
    employee = normalize_code(employee_id)
    org = normalize_code(org_id)
    if not _CODE_RE.match(employee):
        raise HTTPException(status_code=400, detail="工号需为 1–32 位字母、数字、下划线或连字符")
    if not _CODE_RE.match(org):
        raise HTTPException(status_code=400, detail="组织 ID 需为 1–32 位字母、数字、下划线或连字符")
    return employee, org


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 120_000)
    return f"pbkdf2_sha256${_b64(salt)}${_b64(digest)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, salt_b64, digest_b64 = stored.split("$", 2)
    except ValueError:
        return False
    if scheme != "pbkdf2_sha256":
        return False
    salt = _b64decode(salt_b64)
    expected = _b64decode(digest_b64)
    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 120_000)
    return hmac.compare_digest(actual, expected)


def issue_session_token(
    *,
    user_id: str,
    username: str,
    display_name: str,
    employee_id: str = "",
    org_id: str = "",
) -> str:
    payload = {
        "uid": user_id,
        "sub": username,
        "name": display_name,
        "emp": employee_id,
        "org": org_id,
        "exp": int(time.time()) + SESSION_TTL_SECONDS,
    }
    body = _b64(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    sig = hmac.new(_secret(), body.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{body}.{sig}"


def read_session_token(token: str) -> dict[str, Any] | None:
    raw = (token or "").strip()
    if not raw or "." not in raw:
        return None
    body, sig = raw.rsplit(".", 1)
    expected = hmac.new(_secret(), body.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        return None
    try:
        payload = json.loads(_b64decode(body))
    except (json.JSONDecodeError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    exp = int(payload.get("exp") or 0)
    uid = str(payload.get("uid") or "").strip()
    username = str(payload.get("sub") or "").strip()
    if exp < int(time.time()) or not uid or not username:
        return None
    return payload


def session_token_from_request(request: Request | None) -> str:
    if request is None:
        return ""
    header = (
        request.headers.get(LOCAL_SESSION_HEADER) or request.headers.get(LOCAL_SESSION_HEADER.lower()) or ""
    ).strip()
    if header:
        return header
    return (request.cookies.get(LOCAL_SESSION_COOKIE) or "").strip()


def local_session_user_id(request: Request | None) -> str | None:
    payload = read_session_token(session_token_from_request(request))
    if not payload:
        return None
    return str(payload["uid"])


def _avatar_initial(user_id: str, display_name: str) -> str:
    for ch in (display_name or "").strip():
        if ch.isalnum() or "\u4e00" <= ch <= "\u9fff":
            return ch.upper()
    return (user_id or "U")[:1].upper() or "U"


def public_profile(account: LocalAccount) -> dict[str, str]:
    display_name = str(account.display_name or account.username)
    return {
        "user_id": str(account.user_id),
        "username": str(account.username),
        "display_name": display_name,
        "employee_id": str(account.employee_id or ""),
        "org_id": str(account.org_id or ""),
        "avatar_initial": _avatar_initial(str(account.user_id), display_name),
    }


def profile_from_token(payload: dict[str, Any]) -> dict[str, str]:
    user_id = str(payload["uid"])
    username = str(payload["sub"])
    display_name = str(payload.get("name") or username)
    return {
        "user_id": user_id,
        "username": username,
        "display_name": display_name,
        "employee_id": str(payload.get("emp") or ""),
        "org_id": str(payload.get("org") or ""),
        "avatar_initial": _avatar_initial(user_id, display_name),
    }


async def _find_account(db: AsyncSession, login_name: str) -> LocalAccount | None:
    name = normalize_username(login_name)
    account = (
        await db.execute(select(LocalAccount).where(LocalAccount.username == name))
    ).scalar_one_or_none()
    if account is not None:
        return account
    code = normalize_code(login_name)
    if not code:
        return None
    return (
        await db.execute(select(LocalAccount).where(LocalAccount.employee_id == code))
    ).scalar_one_or_none()


async def register_account(
    db: AsyncSession,
    *,
    username: str,
    password: str,
    employee_id: str,
    org_id: str,
    display_name: str | None = None,
) -> tuple[LocalAccount, str]:
    name, secret, shown = validate_credentials(username, password, display_name)
    employee, org = validate_org_codes(employee_id, org_id)
    existing = await _find_account(db, name)
    if existing is not None:
        logger.info("local_auth register rejected username=%s reason=exists", name)
        raise HTTPException(status_code=409, detail="该用户名已注册")
    taken = (
        await db.execute(select(LocalAccount).where(LocalAccount.employee_id == employee))
    ).scalar_one_or_none()
    if taken is not None:
        logger.info("local_auth register rejected employee_id=%s reason=exists", employee)
        raise HTTPException(status_code=409, detail="该工号已注册")
    account = LocalAccount(
        username=name,
        user_id=f"user_{uuid.uuid4().hex[:12]}",
        display_name=shown,
        employee_id=employee,
        org_id=org,
        password_hash=hash_password(secret),
    )
    db.add(account)
    await db.commit()
    await db.refresh(account)
    await set_user_preferences(
        db,
        account.user_id,
        {
            PREF_KEY_UNIFIED_USER_ID: account.user_id,
            PREF_KEY_DISPLAY_NAME: shown,
            PREF_KEY_EMPLOYEE_ID: employee,
            PREF_KEY_ORG_ID: org,
        },
    )
    from backend.services.user_identity import is_global_admin_user

    if not is_global_admin_user(account.user_id):
        await set_platform_role(db, account.user_id, DEFAULT_ROLE)
    token = issue_session_token(
        user_id=account.user_id,
        username=account.username,
        display_name=shown,
        employee_id=employee,
        org_id=org,
    )
    logger.info(
        "local_auth register username=%s employee_id=%s org_id=%s user_id=%s role=%s",
        name,
        employee,
        org,
        account.user_id,
        DEFAULT_ROLE,
    )
    return account, token


async def login_account(db: AsyncSession, *, username: str, password: str) -> tuple[LocalAccount, str]:
    secret = (password or "").strip() or DEFAULT_INITIAL_PASSWORD
    if len(secret) < 6 or len(secret) > 64:
        raise HTTPException(status_code=400, detail="密码长度需为 6–64 位")
    account = await _find_account(db, username)
    if account is None or not verify_password(secret, str(account.password_hash)):
        logger.info("local_auth login failed username=%s", normalize_username(username))
        raise HTTPException(status_code=401, detail="用户名或密码不正确")
    token = issue_session_token(
        user_id=str(account.user_id),
        username=str(account.username),
        display_name=str(account.display_name or account.username),
        employee_id=str(account.employee_id or ""),
        org_id=str(account.org_id or ""),
    )
    logger.info(
        "local_auth login username=%s employee_id=%s user_id=%s",
        account.username,
        account.employee_id or "-",
        account.user_id,
    )
    return account, token


async def update_managed_profile(
    db: AsyncSession,
    *,
    user_id: str,
    display_name: str,
    employee_id: str,
    org_id: str,
) -> dict[str, str]:
    """管理员修改用户名、工号、组织。空工号/组织表示未填写。"""
    shown = (display_name or "").strip()
    if not shown or len(shown) > 32:
        raise HTTPException(status_code=400, detail="用户名需为 1–32 个字")
    employee = normalize_code(employee_id)
    org = normalize_code(org_id)
    if employee and not _CODE_RE.match(employee):
        raise HTTPException(status_code=400, detail="工号需为 1–32 位字母、数字、下划线或连字符")
    if org and not _CODE_RE.match(org):
        raise HTTPException(status_code=400, detail="组织 ID 需为 1–32 位字母、数字、下划线或连字符")
    if employee:
        taken = (
            await db.execute(
                select(LocalAccount).where(
                    LocalAccount.employee_id == employee,
                    LocalAccount.user_id != user_id,
                )
            )
        ).scalar_one_or_none()
        if taken is not None:
            raise HTTPException(status_code=409, detail="该工号已注册")
    account = (
        await db.execute(select(LocalAccount).where(LocalAccount.user_id == user_id))
    ).scalar_one_or_none()
    if account is not None:
        values: dict[str, str | None] = {
            "display_name": shown,
            "employee_id": employee or None,
            "org_id": org or None,
        }
        next_username = normalize_username(shown)
        if _USERNAME_RE.match(next_username) and next_username != account.username:
            clash = (
                await db.execute(select(LocalAccount).where(LocalAccount.username == next_username))
            ).scalar_one_or_none()
            if clash is None:
                values["username"] = next_username
        await db.execute(update(LocalAccount).where(LocalAccount.user_id == user_id).values(**values))
        await db.commit()
    await set_user_preferences(
        db,
        user_id,
        {
            PREF_KEY_DISPLAY_NAME: shown,
            PREF_KEY_EMPLOYEE_ID: employee,
            PREF_KEY_ORG_ID: org,
        },
    )
    logger.info(
        "local_auth profile updated user_id=%s employee_id=%s org_id=%s",
        user_id[:24],
        employee or "-",
        org or "-",
    )
    return {"display_name": shown, "employee_id": employee, "org_id": org}
