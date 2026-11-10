"""探测当前绑定内核的模型接口，不写配置、不回传密钥。"""

from __future__ import annotations

import logging
import os
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

from backend.services.hermes_model_config import _PROVIDER_KEY_ENV, _validate
from backend.services.kernel_binding import _dotenv_get, install_model, read_binding

logger = logging.getLogger("tpdx.hermes.kernel_model_probe")

_ANTHROPIC_PROVIDERS = {"anthropic", "minimax", "minimax-cn"}
_DEFAULT_BASE = {
    "minimax-cn": "https://api.minimaxi.com/anthropic",
    "minimax": "https://api.minimax.io/anthropic",
    "anthropic": "https://api.anthropic.com",
    "openai": "https://api.openai.com/v1",
    "openrouter": "https://openrouter.ai/api/v1",
}


def _clean(value: str) -> str:
    return str(value or "").strip()


def _wire(provider: str, base_url: str) -> str:
    host = (urlparse(base_url).hostname or "").lower()
    path = (urlparse(base_url).path or "").rstrip("/").lower()
    if host == "api.anthropic.com" or path.endswith("/anthropic"):
        return "anthropic_messages"
    if provider in _ANTHROPIC_PROVIDERS:
        return "anthropic_messages"
    return "chat_completions"


def _endpoint(base_url: str, wire: str) -> str:
    root = base_url.rstrip("/")
    if wire == "anthropic_messages":
        if root.endswith("/messages"):
            return root
        if root.endswith("/v1"):
            return f"{root}/messages"
        return f"{root}/v1/messages"
    if root.endswith("/chat/completions"):
        return root
    if root.endswith("/v1"):
        return f"{root}/chat/completions"
    return f"{root}/v1/chat/completions"


def _resolve_key(provider: str, typed: str, dotenv: Path) -> tuple[str, str]:
    secret = _clean(typed)
    if secret:
        return secret, "form"
    env_name = _PROVIDER_KEY_ENV.get(provider)
    if not env_name:
        return "", ""
    from_env = os.getenv(env_name, "").strip()
    if from_env:
        return from_env, "env"
    from_file = _dotenv_get(dotenv, env_name)
    if from_file:
        return from_file, "dotenv"
    return "", env_name


def _request(url: str, headers: dict[str, str], payload: dict[str, Any]) -> httpx.Response:
    timeout = httpx.Timeout(connect=8.0, read=20.0, write=10.0, pool=8.0)
    with httpx.Client(timeout=timeout, trust_env=True, follow_redirects=True) as client:
        return client.post(url, headers=headers, json=payload)


def _result(*, ok: bool, reachable: bool, message: str, latency_ms: int | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"ok": ok, "reachable": reachable, "message": message}
    if latency_ms is not None:
        payload["latency_ms"] = latency_ms
    return payload


def probe_bound_model(*, provider: str, model: str, base_url: str = "", api_key: str = "") -> dict[str, Any]:
    """用表单里的厂商、模型和地址打一次最短请求。密钥留空则用已保存的值。"""
    binding = read_binding()
    if not binding:
        raise ValueError("尚未绑定内核")
    root = Path(binding["root"])
    profile = install_model(binding["kernel_id"], root)
    if not profile["config_exists"]:
        raise ValueError("该内核没有模型配置文件")

    provider_text = _clean(provider) or _clean(profile.get("provider") or "")
    model_name = _clean(model) or _clean(profile.get("model") or "")
    base = _clean(base_url) or _clean(profile.get("base_url") or "") or _DEFAULT_BASE.get(provider_text, "")
    if "provider" in profile.get("fields", []):
        _validate(provider_text, model_name, base)
    elif not model_name:
        return _result(ok=False, reachable=False, message="模型不能为空")
    if base and not base.startswith(("http://", "https://")):
        return _result(ok=False, reachable=False, message="Base URL 需要以 http:// 或 https:// 开头")
    if not base:
        logger.info("kernel model probe skipped reason=empty_base provider=%s", provider_text or "-")
        return _result(ok=False, reachable=False, message="需要 Base URL 才能探测")

    secret, key_source = _resolve_key(provider_text, api_key, root / ".env")
    if not secret:
        if not profile.get("key_writable"):
            logger.info("kernel model probe skipped id=%s reason=key_unmanaged", binding["kernel_id"])
            return _result(ok=False, reachable=False, message="此内核的密钥不在本页管理，无法代测。")
        logger.info("kernel model probe skipped id=%s reason=missing_key", binding["kernel_id"])
        return _result(ok=False, reachable=False, message="密钥未配置，无法探测")

    wire = _wire(provider_text, base)
    url = _endpoint(base, wire)
    headers = {"Content-Type": "application/json"}
    body: dict[str, Any] = {
        "model": model_name,
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "ping"}],
    }
    if wire == "anthropic_messages":
        headers["x-api-key"] = secret
        headers["anthropic-version"] = "2023-06-01"
    else:
        headers["Authorization"] = f"Bearer {secret}"

    host = urlparse(url).hostname or "-"
    started = time.perf_counter()
    try:
        response = _request(url, headers, body)
    except httpx.HTTPError as exc:
        latency_ms = int((time.perf_counter() - started) * 1000)
        logger.info(
            "kernel model probe failed id=%s host=%s wire=%s key_source=%s latency_ms=%s err=%s",
            binding["kernel_id"],
            host,
            wire,
            key_source or "-",
            latency_ms,
            type(exc).__name__,
        )
        return _result(ok=False, reachable=False, latency_ms=latency_ms, message=f"连不上 {host}：{exc.__class__.__name__}")

    latency_ms = int((time.perf_counter() - started) * 1000)
    logger.info(
        "kernel model probe done id=%s host=%s wire=%s status=%s key_source=%s latency_ms=%s",
        binding["kernel_id"],
        host,
        wire,
        response.status_code,
        key_source or "-",
        latency_ms,
    )
    if response.status_code < 300:
        return _result(ok=True, reachable=True, latency_ms=latency_ms, message=f"连通，{model_name} 已响应")
    if response.status_code in {401, 403}:
        return _result(ok=False, reachable=True, latency_ms=latency_ms, message="地址可达，密钥被拒绝")
    snippet = " ".join(response.text.split())[:120]
    detail = f"：{snippet}" if snippet else ""
    return _result(
        ok=False,
        reachable=True,
        latency_ms=latency_ms,
        message=f"地址可达，接口返回 {response.status_code}{detail}",
    )
