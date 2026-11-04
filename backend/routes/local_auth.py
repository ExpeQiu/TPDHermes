"""本机账号：注册、登录、当前会话。"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import get_db
from backend.models.local_account import LocalAccount
from backend.services.local_auth import (
    DEFAULT_INITIAL_PASSWORD,
    login_account,
    profile_from_token,
    public_profile,
    read_session_token,
    register_account,
    session_token_from_request,
)
from backend.services.rbac import PLATFORM_ROLE_LABELS, resolve_platform_role

logger = logging.getLogger("tpdx.hermes.local_auth")

router = APIRouter(prefix="/auth", tags=["auth"])


class RegisterIn(BaseModel):
    username: str = Field(min_length=1, max_length=32)
    employee_id: str = Field(min_length=1, max_length=32)
    org_id: str = Field(min_length=1, max_length=32)
    password: str = Field(default=DEFAULT_INITIAL_PASSWORD, max_length=64)
    display_name: str | None = Field(default=None, max_length=32)


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=32)
    password: str = Field(default=DEFAULT_INITIAL_PASSWORD, max_length=64)


def _session_body(profile: dict[str, str], token: str | None = None) -> dict[str, str | bool | None]:
    body: dict[str, str | bool | None] = {"ok": True, **profile}
    if token is not None:
        body["token"] = token
    return body


@router.post("/register")
async def api_register(body: RegisterIn, db: AsyncSession = Depends(get_db)):
    account, token = await register_account(
        db,
        username=body.username,
        password=body.password,
        employee_id=body.employee_id,
        org_id=body.org_id,
        display_name=body.display_name,
    )
    return _session_body(public_profile(account), token)


@router.post("/login")
async def api_login(body: LoginIn, db: AsyncSession = Depends(get_db)):
    account, token = await login_account(db, username=body.username, password=body.password)
    return _session_body(public_profile(account), token)


@router.get("/session")
async def api_session(req: Request, db: AsyncSession = Depends(get_db)):
    payload = read_session_token(session_token_from_request(req))
    if not payload:
        raise HTTPException(status_code=401, detail="未登录或登录已过期")
    account = (
        await db.execute(select(LocalAccount).where(LocalAccount.user_id == str(payload["uid"])))
    ).scalar_one_or_none()
    profile = public_profile(account) if account is not None else profile_from_token(payload)
    role = await resolve_platform_role(db, req, profile["user_id"])
    profile["platform_role"] = role
    profile["platform_role_label"] = PLATFORM_ROLE_LABELS.get(role, role)
    return _session_body(profile)


@router.post("/logout")
async def api_logout(req: Request):
    payload = read_session_token(session_token_from_request(req))
    user_id = str(payload["uid"])[:24] if payload else ""
    logger.info("local_auth logout user_id=%s", user_id or "-")
    return {"ok": True}
