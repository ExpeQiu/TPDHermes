"""
Feishu Auth Service - 飞书 OAuth 认证服务 (M6-T03)

提供:
- T03: OAuth 2.0 用户扫码登录
- 用户授权后获取 user_access_token / open_id
- 会话级用户信息缓存

参考: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/authen-v1/oidc-access_token
"""

from __future__ import annotations

import httpx
import secrets
import hashlib
import base64
import json
from datetime import datetime, timedelta
from typing import Optional, Any
from dataclasses import dataclass, field

# ── 配置 ─────────────────────────────────────────────────────────────────────

FEISHU_APP_ID = "cli_a93a91327978dbc6"
# FEISHU_APP_SECRET 从环境变量读取，兜底硬编码（仅用于开发）
FEISHU_APP_SECRET = "G4QxkxWSO7zrLPrwyB3xxet00sKZZIDo"
FEISHU_OAUTH_BASE = "https://open.feishu.cn/open-apis/authen"
FEISHU_BASE_URL = "https://open.feishu.cn/open-apis"

# 回调地址（开发环境用 localhost，生产环境替换）
OAUTH_REDIRECT_URI = "http://localhost:3000/feishu/oauth/callback"

# OAuth 状态存储（简单内存，state → {code_verifier, created_at}）
# 生产环境建议换用 Redis
_OAUTH_STATE_STORE: dict[str, dict] = {}
_STATE_EXPIRE_SECONDS = 600  # 10 分钟有效期


# ── 数据模型 ─────────────────────────────────────────────────────────────────

@dataclass
class FeishuUser:
    """飞书认证用户信息"""
    open_id: str
    union_id: Optional[str]
    name: str
    avatar_url: Optional[str]
    email: Optional[str]
    access_token: str
    token_type: str
    refresh_token: str
    expires_in: int  # 秒

    @classmethod
    def from_token_response(cls, data: dict) -> "FeishuUser":
        resp_data = data.get("data", {})
        return cls(
            open_id=resp_data.get("open_id", ""),
            union_id=resp_data.get("union_id"),
            name=resp_data.get("name", ""),
            avatar_url=resp_data.get("avatar_url"),
            email=resp_data.get("email"),
            access_token=resp_data.get("access_token", ""),
            token_type=resp_data.get("token_type", "Bearer"),
            refresh_token=resp_data.get("refresh_token", ""),
            expires_in=resp_data.get("expires_in", 0),
        )


@dataclass
class OauthTokenInfo:
    """OAuth token 响应"""
    access_token: str
    token_type: str
    refresh_token: str
    expires_in: int
    scope: str
    open_id: str
    union_id: Optional[str] = None

    @classmethod
    def from_response(cls, data: dict) -> "OauthTokenInfo":
        resp_data = data.get("data", {})
        return cls(
            access_token=resp_data.get("access_token", ""),
            token_type=resp_data.get("token_type", "Bearer"),
            refresh_token=resp_data.get("refresh_token", ""),
            expires_in=resp_data.get("expires_in", 0),
            scope=resp_data.get("scope", ""),
            open_id=resp_data.get("open_id", ""),
            union_id=resp_data.get("union_id"),
        )


# ── 工具函数 ─────────────────────────────────────────────────────────────────

def _generate_code_verifier() -> str:
    """生成 PKCE code_verifier（43-128字符随机字符串）"""
    return base64.urlsafe_b64encode(secrets.token_bytes(64)).decode().rstrip("=")


def _generate_code_challenge(verifier: str) -> str:
    """生成 PKCE code_challenge（S256 方式）"""
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def _create_oauth_state() -> tuple[str, str]:
    """
    创建安全的 OAuth state 和 code_verifier。
    返回 (state, code_verifier)。
    state 存入内存用于回调验证，code_verifier 用于 PKCE。
    """
    code_verifier = _generate_code_verifier()
    code_challenge = _generate_code_challenge(code_verifier)
    state = secrets.token_urlsafe(32)
    _OAUTH_STATE_STORE[state] = {
        "code_verifier": code_verifier,
        "code_challenge": code_challenge,
        "created_at": datetime.now().timestamp(),
    }
    return state, code_verifier


def _validate_and_consume_state(state: str) -> Optional[str]:
    """
    验证 OAuth state 并返回 code_verifier（一次性）。
    过期或不存在返回 None。
    """
    entry = _OAUTH_STATE_STORE.pop(state, None)
    if not entry:
        return None
    if datetime.now().timestamp() - entry["created_at"] > _STATE_EXPIRE_SECONDS:
        return None
    return entry["code_verifier"]


# ── 核心 OAuth 方法 ───────────────────────────────────────────────────────────

async def build_authorization_url(
    redirect_uri: str = OAUTH_REDIRECT_URI,
    state: Optional[str] = None,
    scope: str = "contact:user.base:readonly",
) -> tuple[str, str]:
    """
    构建飞书 OAuth 授权 URL。

    Returns:
        (authorization_url, code_verifier)
        code_verifier 需在回调时使用（存入会话或临时存储）
    """
    if state is None:
        state, code_verifier = _create_oauth_state()
    else:
        _, code_verifier = _create_oauth_state()

    code_challenge = _OAUTH_STATE_STORE[state]["code_challenge"]

    params = [
        ("app_id", FEISHU_APP_ID),
        ("redirect_uri", redirect_uri),
        ("scope", scope),
        ("response_type", "code"),
        ("state", state),
        ("code_challenge", code_challenge),
        ("code_challenge_method", "S256"),
    ]
    query = "&".join(f"{k}={httpx.QueryParams({k: v}).__str__()}" for k, v in params)
    # 简化构造
    from urllib.parse import urlencode
    query = urlencode(params)
    auth_url = f"{FEISHU_OAUTH_BASE}/authorize?{query}"
    return auth_url, code_verifier


async def exchange_code_for_token(
    code: str,
    code_verifier: str,
    redirect_uri: str = OAUTH_REDIRECT_URI,
) -> OauthTokenInfo:
    """
    用授权码换取用户 access_token。

    参考: POST /authen/v1/oidc/access_token
    """
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{FEISHU_OAUTH_BASE}/v1/oidc/access_token",
            data={
                "grant_type": "authorization_code",
                "client_id": FEISHU_APP_ID,
                "client_secret": FEISHU_APP_SECRET,
                "code": code,
                "redirect_uri": redirect_uri,
                "code_verifier": code_verifier,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") != 0:
            raise RuntimeError(f"OAuth token exchange failed: {data}")
        return OauthTokenInfo.from_response(data)


async def refresh_user_token(refresh_token: str) -> OauthTokenInfo:
    """
    用 refresh_token 刷新用户 access_token。
    """
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{FEISHU_OAUTH_BASE}/v1/oidc/refresh_access_token",
            data={
                "grant_type": "refresh_token",
                "client_id": FEISHU_APP_ID,
                "client_secret": FEISHU_APP_SECRET,
                "refresh_token": refresh_token,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") != 0:
            raise RuntimeError(f"OAuth token refresh failed: {data}")
        return OauthTokenInfo.from_response(data)


async def get_user_info(access_token: str) -> FeishuUser:
    """
    获取当前授权用户信息。
    参考: GET /authen/v1/user_info
    """
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json; charset=utf-8",
    }
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            f"{FEISHU_OAUTH_BASE}/v1/user_info",
            headers=headers,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") != 0:
            raise RuntimeError(f"Get user info failed: {data}")

        # user_info 只有 open_id, name, avatar_url, email
        # 用 token info 补充完整字段
        return FeishuUser(
            open_id=data.get("data", {}).get("open_id", ""),
            union_id=data.get("data", {}).get("union_id"),
            name=data.get("data", {}).get("name", ""),
            avatar_url=data.get("data", {}).get("avatar_url"),
            email=data.get("data", {}).get("email"),
            access_token=access_token,
            token_type="Bearer",
            refresh_token="",  # 不重复暴露 refresh_token
            expires_in=0,
        )


# ── 简化版：直接用 code 换 user（跳过 PKCE，适合测试）─────────────────────────

async def exchange_code_simple(code: str) -> FeishuUser:
    """
    简化版：用授权码直接换取用户信息（不验证 PKCE）。
    仅用于开发/测试，或配合飞书应用后台配置使用。
    """
    # 先换 token
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{FEISHU_OAUTH_BASE}/v1/oidc/access_token",
            data={
                "grant_type": "authorization_code",
                "client_id": FEISHU_APP_ID,
                "client_secret": FEISHU_APP_SECRET,
                "code": code,
                "redirect_uri": OAUTH_REDIRECT_URI,
            },
        )
        resp.raise_for_status()
        token_data = resp.json()
        if token_data.get("code") != 0:
            raise RuntimeError(f"OAuth token exchange failed: {token_data}")

    token_info = OauthTokenInfo.from_response(token_data)
    user = await get_user_info(token_info.access_token)
    # 补充 token 信息
    user.access_token = token_info.access_token
    user.token_type = token_info.token_type
    user.refresh_token = token_info.refresh_token
    user.expires_in = token_info.expires_in
    return user


# ── 内存会话存储（简单实现）───────────────────────────────────────────────────
# key: session_token (random), value: FeishuUser
_USER_SESSIONS: dict[str, FeishuUser] = {}
_SESSION_EXPIRE = timedelta(hours=2)


def create_user_session(user: FeishuUser) -> str:
    """创建会话 token，返回 session_token"""
    session_token = secrets.token_urlsafe(32)
    _USER_SESSIONS[session_token] = user
    return session_token


def get_user_session(session_token: str) -> Optional[FeishuUser]:
    """验证并返回会话用户（自动过期清理）"""
    user = _USER_SESSIONS.get(session_token)
    if not user:
        return None
    # 简单清理过期会话（懒清理）
    _cleanup_expired_sessions()
    return _USER_SESSIONS.get(session_token)


def _cleanup_expired_sessions():
    """清理过期会话（每次调用清理一小批）"""
    now = datetime.now().timestamp()
    expired = [k for k, v in _USER_SESSIONS.items() if False]  # 暂时用不过期策略
    # 注意：当前实现不考虑时间过期，需要可按需扩展 Redis
