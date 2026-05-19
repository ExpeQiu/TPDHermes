"""
Mount Tavily Remote MCP into the local TPDHermes MCP server.

This keeps Tavily web capabilities behind `tphermes-mcp` so Hermes-agent
consumes them as MCP tools from the same upstream server instead of using
Hermes built-in web backends directly.
"""

from __future__ import annotations

import os
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from fastmcp import FastMCP
from fastmcp.server import create_proxy

DEFAULT_TAVILY_REMOTE_MCP_URL = "https://mcp.tavily.com/mcp/"


def _build_remote_url(base_url: str, api_key: str) -> str:
    """Append `tavilyApiKey` when the caller did not inline it in the URL."""
    parsed = urlparse(base_url)
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    if api_key and "tavilyApiKey" not in query:
        query["tavilyApiKey"] = api_key
    return urlunparse(parsed._replace(query=urlencode(query)))


def get_tavily_remote_mcp_url() -> str:
    """Return the Tavily Remote MCP URL, optionally enriched with the API key."""
    base_url = os.getenv("TAVILY_REMOTE_MCP_URL", DEFAULT_TAVILY_REMOTE_MCP_URL).strip()
    api_key = os.getenv("TAVILY_API_KEY", "").strip()
    if not base_url or not api_key:
        return ""
    return _build_remote_url(base_url, api_key)


def mount_tavily_remote_mcp(mcp: FastMCP) -> bool:
    """
    Mount Tavily Remote MCP into `mcp`.

    Returns True when the proxy is mounted, otherwise False.
    """
    remote_url = get_tavily_remote_mcp_url()
    if not remote_url:
        return False

    # Mount the remote server directly so all Tavily tools stay available
    # through the single `tphermes-mcp` endpoint.
    mcp.mount(create_proxy(remote_url, name="Tavily Remote MCP"))
    return True
