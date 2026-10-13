"""访问本机 TPDHermes API。密钥不放进请求日志。"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from tpdhermes.capabilities import public_config, resolve_param, resolve_token

AGENT_CLIENT_HEADER = "X-TPDHermes-Client"
AGENT_TOKEN_HEADER = "X-TPDHermes-Agent-Token"

logger = logging.getLogger("tpdhermes.cli")


def _request_body(action_spec: dict[str, Any], resolved: dict[str, str | None]) -> dict[str, Any] | None:
    kind = action_spec.get("body")
    if kind == "kb_query":
        collection = resolved.get("collection") or ""
        if not collection:
            raise UpstreamError("知识库检索缺少 collection，请在配置中填写默认集合或传入 --collection")
        return {
            "collection_name": collection,
            "query_text": resolved.get("text") or "",
            "n_results": int(resolved.get("n") or "5"),
        }
    if kind == "preview":
        return {
            "project_id": resolved.get("project"),
            "user_message": resolved.get("text") or "（编排预览）",
        }
    if kind == "skill_enable":
        return {"enabled": resolved.get("enabled") == "true"}
    if kind == "task":
        skill = resolved.get("skill") or resolved.get("name")
        payload: dict[str, Any] = {
            "entrypoint": action_spec.get("entrypoint") or "chat",
            "user_message": resolved.get("text") or "",
            "stream": False,
        }
        if resolved.get("project"):
            payload["project_id"] = resolved["project"]
        if action_spec.get("chat_mode"):
            payload["chat_mode"] = action_spec["chat_mode"]
        if skill and action_spec.get("entrypoint") == "workshop":
            payload["overrides"] = {
                "skills": {
                    "mode": "manual_only",
                    "allowed": [skill],
                    "allow_agent_free_choice": False,
                }
            }
        return payload
    return None


class UpstreamError(RuntimeError):
    def __init__(self, message: str, *, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


def live_transport(
    spec: dict[str, Any],
    action: str,
    params: dict[str, str | None],
    *,
    user_id: str | None = None,
    token: str | None = None,
) -> Any:
    view = public_config()
    base = (view.get("api_base") or "").rstrip("/")
    action_spec = spec["actions"][action]
    module_id = spec["id"]
    resolved = {
        key: resolve_param(module_id, key, params.get(key))
        for key in ("id", "project", "name", "text", "collection", "n", "skill", "output", "file", "enabled")
    }
    if not resolved.get("name") and resolved.get("skill"):
        resolved["name"] = resolved["skill"]
    path = action_spec["path"].format(
        id=resolved.get("id") or "",
        project=resolved.get("project") or "",
        name=resolved.get("name") or "",
        output=resolved.get("output") or "",
        file=resolved.get("file") or "",
    )
    headers: dict[str, str] = {}
    uid = (user_id or "").strip() or (view.get("user_id") or "")
    if isinstance(uid, str) and uid.strip():
        headers["X-User-ID"] = uid.strip()
    presented = (token or "").strip() or resolve_token()
    headers[AGENT_CLIENT_HEADER] = "cli"
    if presented:
        headers[AGENT_TOKEN_HEADER] = presented
        logger.info("cli http token_set=true")
    else:
        logger.info("cli http token_set=false")
    url = f"{base}{path}"
    query: dict[str, str] = {}
    for query_name, key in (action_spec.get("query") or {}).items():
        value = resolved.get(key)
        if isinstance(value, str) and value.strip():
            query[query_name] = value.strip()
    body = _request_body(action_spec, resolved)
    timeout = 120.0 if action_spec.get("body") == "task" else 30.0
    logger.info("cli http %s %s module=%s action=%s", action_spec["method"], path, module_id, action)
    try:
        response = httpx.request(
            action_spec["method"],
            url,
            headers=headers,
            params=query or None,
            json=body,
            timeout=timeout,
        )
    except httpx.HTTPError as exc:
        raise UpstreamError(f"无法连接 {base}: {exc}") from exc
    if response.status_code == 404:
        raise UpstreamError("未找到资源", status_code=404)
    if response.status_code >= 400:
        detail = response.text[:300]
        raise UpstreamError(f"上游 HTTP {response.status_code}: {detail}", status_code=response.status_code)
    if not response.content:
        return []
    return response.json()
