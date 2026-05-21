"""Hermes-agent MCP 管理 API。"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from backend.services import mcp_registry

logger = logging.getLogger("tpdx.hermes.mcp")

router = APIRouter(prefix="/mcp", tags=["mcp"])


class McpServerUpdateRequest(BaseModel):
    enabled: bool | None = None
    tools_include: list[str] | None = Field(default=None, description="Hermes config tools.include 白名单")


@router.get("/servers")
async def api_list_mcp_servers():
    return mcp_registry.list_servers()


@router.get("/servers/{name}")
async def api_get_mcp_server(name: str):
    data = mcp_registry.list_servers()
    for server in data["servers"]:
        if server["name"] == name:
            return server
    raise HTTPException(status_code=404, detail=f"MCP server not found: {name}")


@router.patch("/servers/{name}")
async def api_update_mcp_server(name: str, body: McpServerUpdateRequest, req: Request):
    try:
        updated = mcp_registry.update_server(
            name,
            enabled=body.enabled,
            tools_include=body.tools_include,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail=f"MCP server not found: {name}") from None
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        logger.error("Failed to write MCP config name=%s err=%s", name, exc)
        raise HTTPException(status_code=500, detail=f"无法写入配置文件: {exc}") from exc
    logger.info(
        "MCP server updated name=%s enabled=%s tools=%s actor=%s",
        name,
        body.enabled,
        len(body.tools_include or []),
        req.headers.get("X-User-ID") or req.headers.get("x-user-id") or "unknown",
    )
    return updated


@router.post("/servers/{name}/probe")
async def api_probe_mcp_server(name: str):
    data = mcp_registry.list_servers()
    server = next((s for s in data["servers"] if s["name"] == name), None)
    if not server:
        raise HTTPException(status_code=404, detail=f"MCP server not found: {name}")
    result = await mcp_registry.probe_server(server.get("url") or "")
    return {"name": name, **result}
