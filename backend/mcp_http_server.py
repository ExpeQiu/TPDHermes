"""
TPDHermes MCP HTTP entrypoint.

Runs the existing FastMCP tool surface over Streamable HTTP so hermes-agent can
connect to it as a network MCP server inside Docker Compose.
"""

from __future__ import annotations

import os

from backend.mcp_server import mcp


def _get_env(name: str, default: str) -> str:
    value = os.getenv(name, "").strip()
    return value or default


def main() -> None:
    host = _get_env("TPDHERMES_MCP_HOST", "0.0.0.0")
    port = int(_get_env("TPDHERMES_MCP_PORT", "8801"))
    path = _get_env("TPDHERMES_MCP_PATH", "/mcp")
    transport = _get_env("TPDHERMES_MCP_TRANSPORT", "streamable-http")
    log_level = _get_env("TPDHERMES_MCP_LOG_LEVEL", "info")

    mcp.run(
        transport=transport,
        host=host,
        port=port,
        path=path,
        log_level=log_level,
        show_banner=False,
    )


if __name__ == "__main__":
    main()
