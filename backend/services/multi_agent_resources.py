"""
multi-agent Pack / Role 配置桥接。

优先经 MULTI_AGENT_URL HTTP 代理；不可达时回退 MULTI_AGENT_ROOT 下的 SDK/文件系统。
供设置页 P-team / Roles 管理使用，浏览器不直连 multi-agent。
"""
from __future__ import annotations

import logging
import sys
from typing import Any

import httpx

from backend.services.brainstorm_bridge import (
    BrainstormBridgeError,
    multi_agent_http_base,
    resolve_multi_agent_root,
)

logger = logging.getLogger("tpdx.hermes.multi_agent_resources")

HTTP_TIMEOUT_SEC = 30.0


class MultiAgentResourceError(Exception):
    """Pack / Role 读写失败。"""

    def __init__(self, message: str, *, status_code: int = 500):
        super().__init__(message)
        self.status_code = status_code


def _inject_sdk() -> None:
    root = resolve_multi_agent_root()
    if root is None:
        raise MultiAgentResourceError(
            "未找到 TPD-multi-agent：请启动 multi-agent Web（MULTI_AGENT_URL）或设置 MULTI_AGENT_ROOT",
            status_code=503,
        )
    root_s = str(root)
    if root_s not in sys.path:
        sys.path.insert(0, root_s)
        logger.info("已注入 MULTI_AGENT_ROOT 到 sys.path: %s", root_s)


def _map_sdk_error(exc: Exception) -> MultiAgentResourceError:
    name = type(exc).__name__
    msg = str(exc) or name
    if name == "MultiAgentError":
        lower = msg.lower()
        if "未知" in msg or "不存在" in msg or "not found" in lower:
            return MultiAgentResourceError(msg, status_code=404)
        if "已存在" in msg or "须为" in msg or "需要" in msg or "无效" in msg or "至少" in msg:
            return MultiAgentResourceError(msg, status_code=400)
        return MultiAgentResourceError(msg, status_code=400)
    return MultiAgentResourceError(msg, status_code=500)


async def _http_json(
    method: str,
    path: str,
    *,
    body: dict[str, Any] | None = None,
) -> Any:
    base = multi_agent_http_base()
    url = f"{base}{path}"
    try:
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SEC) as client:
            resp = await client.request(
                method,
                url,
                json=body if body is not None else None,
            )
    except Exception as exc:  # noqa: BLE001
        logger.warning("multi-agent HTTP 不可达 method=%s path=%s err=%s", method, path, exc)
        raise BrainstormBridgeError(str(exc)) from exc

    data: Any = {}
    try:
        data = resp.json()
    except Exception:  # noqa: BLE001
        data = {"error": (resp.text or "")[:300]}

    if resp.status_code >= 400:
        err = ""
        if isinstance(data, dict):
            err = str(data.get("error") or data.get("detail") or "")
        raise MultiAgentResourceError(
            err or f"multi-agent HTTP {resp.status_code}",
            status_code=resp.status_code if resp.status_code < 500 else 502,
        )
    return data


async def list_packs() -> dict[str, Any]:
    try:
        data = await _http_json("GET", "/api/packs")
        items = data.get("items") if isinstance(data, dict) else []
        logger.info("列出 Pack（HTTP） count=%s", len(items or []))
        return {"items": items or [], "source": "http"}
    except (BrainstormBridgeError, MultiAgentResourceError) as http_exc:
        logger.info("列出 Pack 回退 SDK: %s", http_exc)
        try:
            _inject_sdk()
            from multi_agent.skill_packs import list_packs_meta

            items = list_packs_meta()
            logger.info("列出 Pack（SDK） count=%s", len(items))
            return {"items": items, "source": "sdk"}
        except MultiAgentResourceError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise _map_sdk_error(exc) from exc


async def get_pack(pack_id: str) -> dict[str, Any]:
    pid = (pack_id or "").strip()
    if not pid:
        raise MultiAgentResourceError("pack id 不能为空", status_code=400)
    try:
        data = await _http_json("GET", f"/api/packs/{pid}")
        if isinstance(data, dict):
            data = {**data, "source": "http"}
        logger.info("读取 Pack（HTTP） id=%s", pid)
        return data
    except MultiAgentResourceError as exc:
        if exc.status_code < 500:
            raise
        logger.info("读取 Pack 回退 SDK id=%s: %s", pid, exc)
    except BrainstormBridgeError as http_exc:
        logger.info("读取 Pack 回退 SDK id=%s: %s", pid, http_exc)

    try:
        _inject_sdk()
        from multi_agent.skill_packs import load_pack

        data = load_pack(pid)
        clean = {k: v for k, v in data.items() if not str(k).startswith("_")}
        clean["source"] = "sdk"
        logger.info("读取 Pack（SDK） id=%s", pid)
        return clean
    except MultiAgentResourceError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _map_sdk_error(exc) from exc


async def save_pack(payload: dict[str, Any], *, create: bool) -> dict[str, Any]:
    pid = str(payload.get("id") or "").strip()
    path = "/api/packs" if create else f"/api/packs/{pid}"
    method = "POST" if create else "PUT"
    try:
        data = await _http_json(method, path, body=payload)
        if isinstance(data, dict):
            data = {**data, "source": "http"}
        logger.info("保存 Pack（HTTP） id=%s create=%s", pid, create)
        return data
    except MultiAgentResourceError as exc:
        if exc.status_code < 500:
            raise
        logger.info("保存 Pack 回退 SDK id=%s create=%s: %s", pid, create, exc)
    except BrainstormBridgeError as http_exc:
        logger.info("保存 Pack 回退 SDK id=%s create=%s: %s", pid, create, http_exc)

    try:
        _inject_sdk()
        from multi_agent.skill_packs import save_pack as sdk_save_pack

        data = sdk_save_pack(payload, create=create)
        data["source"] = "sdk"
        logger.info("保存 Pack（SDK） id=%s create=%s", data.get("id"), create)
        return data
    except MultiAgentResourceError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _map_sdk_error(exc) from exc


async def list_roles() -> dict[str, Any]:
    try:
        data = await _http_json("GET", "/api/roles")
        items = data.get("items") if isinstance(data, dict) else []
        logger.info("列出 Role（HTTP） count=%s", len(items or []))
        return {"items": items or [], "source": "http"}
    except (BrainstormBridgeError, MultiAgentResourceError) as http_exc:
        logger.info("列出 Role 回退 SDK: %s", http_exc)
        try:
            _inject_sdk()
            from multi_agent.roles import list_roles_meta

            items = list_roles_meta()
            logger.info("列出 Role（SDK） count=%s", len(items))
            return {"items": items, "source": "sdk"}
        except MultiAgentResourceError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise _map_sdk_error(exc) from exc


async def get_role(role_id: str) -> dict[str, Any]:
    rid = (role_id or "").strip()
    if not rid:
        raise MultiAgentResourceError("role id 不能为空", status_code=400)
    try:
        data = await _http_json("GET", f"/api/roles/{rid}")
        if isinstance(data, dict):
            data = {**data, "source": "http"}
        logger.info("读取 Role（HTTP） id=%s", rid)
        return data
    except MultiAgentResourceError as exc:
        if exc.status_code < 500:
            raise
        logger.info("读取 Role 回退 SDK id=%s: %s", rid, exc)
    except BrainstormBridgeError as http_exc:
        logger.info("读取 Role 回退 SDK id=%s: %s", rid, http_exc)

    try:
        _inject_sdk()
        from multi_agent.roles import load_role

        data = load_role(rid)
        data["source"] = "sdk"
        logger.info("读取 Role（SDK） id=%s", rid)
        return data
    except MultiAgentResourceError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _map_sdk_error(exc) from exc


async def save_role(payload: dict[str, Any], *, create: bool) -> dict[str, Any]:
    rid = str(payload.get("id") or "").strip()
    path = "/api/roles" if create else f"/api/roles/{rid}"
    method = "POST" if create else "PUT"
    try:
        data = await _http_json(method, path, body=payload)
        if isinstance(data, dict):
            data = {**data, "source": "http"}
        logger.info("保存 Role（HTTP） id=%s create=%s", rid, create)
        return data
    except MultiAgentResourceError as exc:
        if exc.status_code < 500:
            raise
        logger.info("保存 Role 回退 SDK id=%s create=%s: %s", rid, create, exc)
    except BrainstormBridgeError as http_exc:
        logger.info("保存 Role 回退 SDK id=%s create=%s: %s", rid, create, http_exc)

    try:
        _inject_sdk()
        from multi_agent.roles import save_role as sdk_save_role

        data = sdk_save_role(payload, create=create)
        data["source"] = "sdk"
        logger.info("保存 Role（SDK） id=%s create=%s", data.get("id"), create)
        return data
    except MultiAgentResourceError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _map_sdk_error(exc) from exc


async def delete_role(role_id: str) -> dict[str, Any]:
    rid = (role_id or "").strip()
    if not rid:
        raise MultiAgentResourceError("role id 不能为空", status_code=400)
    try:
        data = await _http_json("DELETE", f"/api/roles/{rid}")
        if isinstance(data, dict):
            data = {**data, "source": "http"}
        else:
            data = {"ok": True, "id": rid, "source": "http"}
        logger.info("删除 Role（HTTP） id=%s", rid)
        return data
    except MultiAgentResourceError as exc:
        if exc.status_code < 500:
            raise
        logger.info("删除 Role 回退 SDK id=%s: %s", rid, exc)
    except BrainstormBridgeError as http_exc:
        logger.info("删除 Role 回退 SDK id=%s: %s", rid, http_exc)

    try:
        _inject_sdk()
        from multi_agent.roles import delete_role as sdk_delete_role

        sdk_delete_role(rid)
        logger.info("删除 Role（SDK） id=%s", rid)
        return {"ok": True, "id": rid, "source": "sdk"}
    except MultiAgentResourceError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _map_sdk_error(exc) from exc