"""Local CutPot workbench adapter for TPDHermes project owners."""

import asyncio
import hashlib
import json
import os
import shutil
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse, urlunparse

from fastapi import HTTPException


def workspace_id(project_id: str | None, user_id: str) -> str:
    """有项目时按项目隔离；未选项目时用当前用户的本机工作区。"""
    bound = (project_id or "").strip()
    if bound:
        return bound
    owner = (user_id or "").strip() or "default"
    return f"user:{owner}"


def _public_urls(data: dict[str, Any]) -> dict[str, Any]:
    host = os.getenv("STUDIO_PUBLIC_HOST", "").strip()
    if not host:
        return data
    rewritten = dict(data)
    for key in ("url", "webUrl"):
        value = rewritten.get(key)
        if not isinstance(value, str):
            continue
        parsed = urlparse(value)
        if parsed.hostname not in {"127.0.0.1", "localhost"} or not parsed.port:
            continue
        rewritten[key] = urlunparse(parsed._replace(netloc=f"{host}:{parsed.port}"))
    return rewritten


async def call_cutpot(
    project_id: str,
    command: Literal["connect", "turn", "disconnect"],
    operation: Literal["project-show", "project-rename"] = "project-show",
    **inputs: str,
) -> dict[str, Any]:
    root = os.getenv("TPCSTORE_ROOT", "").strip()
    node = shutil.which(os.getenv("TPCSTORE_NODE_BIN", "node"))
    entry = Path(root).expanduser() / "cutpot" / "workbench.mjs"
    if not root or not node or not entry.is_file():
        raise HTTPException(503, "CutPot 工作台未连接，请检查 TPCSTORE_ROOT 和 Node.js")
    base = Path(
        os.getenv("TPCSTORE_APP_DATA") or Path.home() / ".tpcstore/tpdhermes-v04"
    )
    directory = (
        base.resolve() / "cutpot" / hashlib.sha256(project_id.encode()).hexdigest()
    )
    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(Path.home()),
        "TPCSTORE_APP_DATA": str(directory),
    }
    if os.getenv("STUDIO_PUBLIC_HOST"):
        env["STUDIO_PUBLIC_HOST"] = os.environ["STUDIO_PUBLIC_HOST"]
        env["BIND_HOST"] = os.getenv("BIND_HOST", "0.0.0.0")
        env["CUTPOT_PORT"] = os.getenv("CUTPOT_PORT", "4317")
    proc = await asyncio.create_subprocess_exec(
        node,
        str(entry.resolve()),
        command,
        "--json",
        env=env,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    payload = {"schema_version": "1.0.0", "operation": operation, "input": inputs}
    try:
        stdout, _ = await asyncio.wait_for(
            proc.communicate(
                json.dumps(payload).encode() if command == "turn" else b""
            ),
            timeout=40,
        )
    except (TimeoutError, asyncio.CancelledError) as exc:
        if proc.returncode is None:
            proc.kill()
        await proc.communicate()
        if isinstance(exc, asyncio.CancelledError):
            raise
        raise HTTPException(504, "CutPot 调用超时，请回读工程确认结果") from exc
    try:
        response = json.loads(stdout)
        if response["schema_version"] != "1.0.0" or response["command"] != command:
            raise ValueError("unexpected envelope")
        if proc.returncode or response["ok"] is not True:
            error = response["error"]["code"]
            status = {
                "REVISION_CONFLICT": 409,
                "BUSY": 409,
                "DEPENDENCY_UNAVAILABLE": 503,
            }.get(error, 502)
            raise HTTPException(
                status, f"CutPot {error}：{response['error']['message']}"
            )
        if not isinstance(response["data"], dict):
            raise ValueError("invalid data")
        return _public_urls(response["data"])
    except (ValueError, TypeError, KeyError) as exc:
        raise HTTPException(502, "CutPot 返回契约无效") from exc
