"""Local CutPot workbench adapter for TPDHermes project owners."""

import asyncio
import hashlib
import json
import os
import shutil
from pathlib import Path
from typing import Any, Literal

from fastapi import HTTPException


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
        return response["data"]
    except (ValueError, TypeError, KeyError) as exc:
        raise HTTPException(502, "CutPot 返回契约无效") from exc
