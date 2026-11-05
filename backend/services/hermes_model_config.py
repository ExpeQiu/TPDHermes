"""Hermes-agent 主模型：读写 deploy/hermes-agent/config.yaml 的 model 段。

页面保存的 provider / default / base_url 以该文件为准。
密钥留在 hermes 容器环境变量里，响应里只给出是否已配置。
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from typing import Any

import yaml

from backend.services.mcp_registry import get_config_path, load_config

logger = logging.getLogger("tpdx.hermes.hermes_model")

_PROVIDER_KEY_ENV = {
    "minimax": "MINIMAX_API_KEY",
    "minimax-cn": "MINIMAX_CN_API_KEY",
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "google": "GOOGLE_API_KEY",
    "gemini": "GEMINI_API_KEY",
    "nous": "NOUS_API_KEY",
    "glm": "GLM_API_KEY",
    "kimi": "KIMI_API_KEY",
}

_SECRET_KEYS = {"api_key", "apikey", "key", "token", "access_token"}


def _clean(value: Any) -> str:
    return str(value or "").strip()


def _model_mapping(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return dict(raw)
    if isinstance(raw, str) and raw.strip():
        return {"default": raw.strip()}
    return {}


def _public_model_name(model: dict[str, Any]) -> str:
    for key in ("default", "model", "name"):
        text = _clean(model.get(key))
        if text:
            return text
    return ""


def _hermes_dotenv_paths() -> list[Path]:
    """Hermes 读密钥的 .env。HERMES_HOME 已写出时只看该目录。"""
    raw = os.getenv("HERMES_HOME", "").strip()
    if raw:
        return [Path(raw).expanduser() / ".env"]
    return [Path.home() / ".hermes" / ".env"]


def _dotenv_has(name: str) -> bool:
    for path in _hermes_dotenv_paths():
        if not path.is_file():
            continue
        try:
            lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
        except OSError as exc:
            logger.warning("hermes dotenv unreadable path=%s err=%s", path, exc)
            continue
        for raw in lines:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[len("export ") :]
            if not line.startswith(f"{name}="):
                continue
            value = line.split("=", 1)[1].strip().strip('"').strip("'")
            if value:
                return True
    return False


def _key_status(provider: str, model: dict[str, Any]) -> tuple[str | None, bool]:
    env_name = _PROVIDER_KEY_ENV.get(provider)
    if env_name:
        configured = bool(os.getenv(env_name, "").strip()) or _dotenv_has(env_name)
        return env_name, configured
    for key in _SECRET_KEYS:
        if _clean(model.get(key)):
            return None, True
    return None, False


def _writable(path) -> bool:
    parent = path.parent
    if path.exists():
        return os.access(path, os.W_OK)
    return os.access(parent, os.W_OK) if parent.exists() else True


def read_hermes_model() -> dict[str, Any]:
    path = get_config_path()
    config = load_config()
    model = _model_mapping(config.get("model"))
    provider = _clean(model.get("provider"))
    key_env, key_configured = _key_status(provider, model)
    payload = {
        "provider": provider,
        "model": _public_model_name(model),
        "base_url": _clean(model.get("base_url")),
        "config_path": str(path),
        "config_exists": path.is_file(),
        "writable": _writable(path),
        "key_env": key_env,
        "key_configured": key_configured,
        "applies": "new_session",
    }
    logger.info(
        "hermes model shown provider=%s model=%s base_url_set=%s key_configured=%s",
        payload["provider"] or "-",
        payload["model"] or "-",
        bool(payload["base_url"]),
        key_configured,
    )
    return payload


def _validate(provider: str, model_name: str, base_url: str, api_key: str = "") -> None:
    if not provider or not model_name:
        raise ValueError("厂商和模型不能为空")
    for label, value, limit in (
        ("厂商", provider, 128),
        ("模型", model_name, 256),
        ("Base URL", base_url, 512),
        ("密钥", api_key, 512),
    ):
        if len(value) > limit or re.search(r"[\r\n\x00]", value):
            raise ValueError(f"{label}无效")
    if base_url and not base_url.startswith(("http://", "https://")):
        raise ValueError("Base URL 需要以 http:// 或 https:// 开头")


def _ordered_model(existing: dict[str, Any], *, provider: str, model_name: str, base_url: str) -> dict[str, Any]:
    merged = {key: value for key, value in existing.items() if key not in {"default", "model", "name", "provider", "base_url"}}
    ordered: dict[str, Any] = {"default": model_name, "provider": provider}
    if base_url:
        ordered["base_url"] = base_url
    for key, value in merged.items():
        ordered[key] = value
    return ordered


def _dump_model_block(model: dict[str, Any]) -> str:
    text = yaml.safe_dump(
        {"model": model},
        allow_unicode=True,
        default_flow_style=False,
        sort_keys=False,
    )
    if not text.endswith("\n"):
        text += "\n"
    return text


def _replace_model_block(text: str, block: str) -> str:
    lines = text.splitlines(keepends=True)
    start = next((i for i, line in enumerate(lines) if re.match(r"model\s*:", line)), None)
    if start is None:
        if not text:
            return block
        if not block.endswith("\n"):
            block += "\n"
        return block + text
    end = start + 1
    while end < len(lines):
        stripped = lines[end].strip()
        if stripped == "" or stripped.startswith("#") or lines[end][:1] in {" ", "\t"}:
            end += 1
            continue
        break
    while end > start + 1:
        prev = lines[end - 1].strip()
        if prev == "" or prev.startswith("#"):
            end -= 1
            continue
        break
    if not block.endswith("\n"):
        block += "\n"
    return "".join(lines[:start] + [block] + lines[end:])


def _dotenv_path() -> Path:
    raw = os.getenv("HERMES_HOME", "").strip()
    home = Path(raw).expanduser() if raw else Path.home() / ".hermes"
    return home / ".env"


def _quote_env_value(value: str) -> str:
    if re.search(r"""[\s#"']""", value):
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return value


def _upsert_provider_key(env_name: str, value: str) -> None:
    path = _dotenv_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = path.read_text(encoding="utf-8").splitlines(keepends=True) if path.is_file() else []
    matcher = re.compile(rf"^(?:export\s+)?{re.escape(env_name)}=")
    written = f"{env_name}={_quote_env_value(value)}\n"
    replaced = False
    kept: list[str] = []
    for line in lines:
        if matcher.match(line.strip()) and not line.strip().startswith("#"):
            if not replaced:
                kept.append(written)
                replaced = True
            continue
        kept.append(line if line.endswith("\n") else line + "\n")
    if not replaced:
        if kept and not kept[-1].endswith("\n"):
            kept[-1] += "\n"
        kept.append(written)
    mode = path.stat().st_mode if path.is_file() else 0o600
    tmp = path.parent / f"{path.name}.tmp"
    tmp.write_text("".join(kept), encoding="utf-8")
    tmp.chmod(mode)
    tmp.replace(path)
    logger.info("hermes provider key updated env=%s path=%s", env_name, path)


def save_hermes_model(*, provider: str, model: str, base_url: str = "", api_key: str = "") -> dict[str, Any]:
    provider_text = _clean(provider)
    model_name = _clean(model)
    base = _clean(base_url)
    secret = _clean(api_key)
    _validate(provider_text, model_name, base, secret)
    if secret and provider_text not in _PROVIDER_KEY_ENV:
        raise ValueError("该厂商的密钥不在本页写入，留空则只改模型")

    path = get_config_path()
    existing = _model_mapping(load_config().get("model"))
    written = _ordered_model(existing, provider=provider_text, model_name=model_name, base_url=base)
    block = _dump_model_block(written)
    original = path.read_text(encoding="utf-8") if path.is_file() else ""
    updated = _replace_model_block(original, block)

    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_file():
        path.with_suffix(path.suffix + ".bak").write_text(original, encoding="utf-8")
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(updated, encoding="utf-8")
    tmp.replace(path)
    logger.info(
        "hermes model saved provider=%s model=%s base_url_set=%s key_updated=%s path=%s",
        provider_text,
        model_name,
        bool(base),
        bool(secret),
        path,
    )
    if secret:
        _upsert_provider_key(_PROVIDER_KEY_ENV[provider_text], secret)
    return read_hermes_model()
