"""TPCstore V04 本机 CLI 适配：资料由服务端读取，argv/JSON 交接，不使用 Shell。"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import shutil
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.output_asset import OutputAsset
from backend.models.project_attachment import ProjectAttachment
from backend.services.project_access import require_project_for_user
from backend.services.project_files_service import _attachments_root

logger = logging.getLogger("tpdx.hermes.tpcstore")

PRODUCTS: dict[str, dict[str, str]] = {
    "V04": {"dir": "V04-tech-cards", "prefix": "tech-cards", "data": "tpdhermes-v04"},
    "V05": {"dir": "V05-value-chain", "prefix": "value-chain", "data": "tpdhermes-v05"},
    "V10": {"dir": "V10-claim-evidence", "prefix": "claim-evidence", "data": "tpdhermes-v10"},
}
APP_PRODUCTS = frozenset({"V05", "V10"})
APP_OPERATIONS: dict[str, frozenset[str]] = {
    "V05": frozenset({
        "show", "import", "patch-link", "unlock", "revoke-support", "suggest",
        "task-show", "wait", "cancel", "select-value", "export",
    }),
    "V10": frozenset({
        "show", "import", "suggest", "task-show", "wait", "cancel", "patch-link",
        "revise-claim", "unlock", "revoke-evidence", "confirm-strength", "export",
    }),
}


def _command(product: str = "V04") -> list[str]:
    spec = PRODUCTS.get(product)
    if spec is None:
        raise HTTPException(404, "未接入的技能卡")
    configured = os.getenv("TPCSTORE_ROOT", "").strip()
    node = shutil.which(os.getenv("TPCSTORE_NODE_BIN", "node"))
    if not configured or not node:
        raise HTTPException(503, "TPCstore 未连接：请配置 TPCSTORE_ROOT 和 Node.js")
    entry = Path(configured).expanduser().resolve() / spec["dir"] / "cli.mjs"
    if not entry.is_file():
        raise HTTPException(503, f"TPCstore {product} CLI 不存在，请检查连接目录")
    return [node, str(entry)]


def product_data_dir(product: str) -> str:
    if product == "V04":
        return os.getenv("TPCSTORE_APP_DATA") or str(Path.home() / ".tpcstore" / "tpdhermes-v04")
    override = os.getenv(f"TPCSTORE_{product}_APP_DATA", "").strip()
    if override:
        return str(Path(override).expanduser())
    folder = PRODUCTS[product]["data"]
    return str(Path.home() / ".tpcstore" / folder)


def read_workbench_html(product: str = "V04") -> str:
    page = Path(_command(product)[1]).with_name("workbench.html")
    try:
        return page.read_text(encoding="utf-8")
    except OSError as exc:
        raise HTTPException(503, f"TPCstore {product} 工作台页面不可用") from exc


def read_product_fixture(product: str) -> dict[str, Any]:
    if product not in APP_PRODUCTS:
        raise HTTPException(404, "该技能卡没有示例")
    page = Path(_command(product)[1]).parent / "fixtures"
    name = "pitch-control.json" if product == "V05" else "pitch-claim.json"
    try:
        payload = json.loads((page / name).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(503, f"TPCstore {product} 示例不可用") from exc
    if not isinstance(payload, dict):
        raise HTTPException(503, f"TPCstore {product} 示例无效")
    return payload


def _child_env(*, needs_model: bool = True, app_data: str | None = None) -> dict[str, str]:
    key = os.getenv("TPCSTORE_MODEL_KEY", "")
    env_file = os.getenv("TPCSTORE_MODEL_ENV_FILE", "").strip()
    if needs_model and not key and env_file:
        try:
            for raw in Path(env_file).expanduser().read_text().splitlines():
                line = raw.strip().removeprefix("export ")
                if line.startswith("API_SERVER_KEY="):
                    key = line.split("=", 1)[1].strip().strip("\"'")
                    break
        except OSError as exc:
            raise HTTPException(503, "TPCstore 受保护网关配置不可读") from exc
        if not key:
            raise HTTPException(503, "TPCstore 受保护网关配置缺少 API_SERVER_KEY")
    return {
        "PATH": os.environ.get("PATH", ""),
        "TPCSTORE_APP_DATA": app_data or product_data_dir("V04"),
        "LANG": "en_US.UTF-8",
        "TPCSTORE_MODEL_URL": os.getenv("TPCSTORE_MODEL_URL", "")
        or os.getenv("HERMES_CHAT_API_URL", ""),
        "TPCSTORE_MODEL_KEY": key or os.getenv("HERMES_CHAT_API_KEY", ""),
        "TPCSTORE_MODEL": os.getenv("TPCSTORE_MODEL", "")
        or os.getenv("HERMES_CHAT_MODEL", "hermes-agent"),
        "TPCSTORE_MODEL_TIMEOUT_SECONDS": os.getenv(
            "TPCSTORE_MODEL_TIMEOUT_SECONDS", "90"
        ),
    }


async def call_tpcstore(
    command: str,
    payload: dict[str, Any] | None = None,
    *,
    product: str = "V04",
    needs_model: bool | None = None,
) -> dict[str, Any]:
    argv = [*_command(product), command, "--json"]
    try:
        timeout = float(os.getenv("TPCSTORE_MODEL_TIMEOUT_SECONDS", "90")) + 10
    except ValueError as exc:
        raise HTTPException(503, "TPCstore 超时配置无效") from exc
    if not 11 <= timeout <= 310:
        raise HTTPException(503, "TPCstore 模型超时必须为 1–300 秒")
    if needs_model is None:
        needs_model = (
            product == "V04"
            and (command != "workspace" or (payload or {}).get("operation") == "extract")
        )
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=_child_env(
                needs_model=needs_model,
                app_data=None if product == "V04" else product_data_dir(product),
            ),
        )
    except OSError as exc:
        raise HTTPException(503, "TPCstore CLI 无法启动") from exc
    try:
        stdout, _stderr = await asyncio.wait_for(
            proc.communicate(
                json.dumps(payload, ensure_ascii=False).encode()
                if payload is not None
                else b""
            ),
            timeout=timeout,
        )
    except (asyncio.TimeoutError, asyncio.CancelledError) as exc:
        if proc.returncode is None:
            proc.kill()
        await proc.communicate()
        if isinstance(exc, asyncio.CancelledError):
            raise
        raise HTTPException(
            504, "TPCstore 调用结果不明，未自动重提；本地进程结束不代表上游推理取消"
        ) from exc
    try:
        envelope = json.loads(stdout)
        if not isinstance(envelope, dict) or envelope.get("schema_version") != "1.0.0":
            raise ValueError("invalid envelope")
        expected = f"{PRODUCTS[product]['prefix']}.{command}"
        if envelope.get("command") != expected or type(envelope.get("ok")) is not bool:
            raise ValueError("invalid command")
    except (ValueError, UnicodeDecodeError) as exc:
        raise HTTPException(502, "TPCstore 返回契约无效；未采用结果") from exc
    returncode = proc.returncode if proc.returncode is not None else 3
    if returncode != 0 or not envelope["ok"]:
        error = envelope.get("error") or {}
        status = {1: 422, 4: 422, 5: 409, 6: 502, 8: 503}.get(returncode, 502)
        logger.warning(
            "tpcstore failed product=%s command=%s code=%s",
            product,
            command,
            error.get("code"),
        )
        raise HTTPException(
            status,
            f"TPCstore {error.get('code', 'EXECUTION_FAILED')}：{error.get('message', '执行失败')}",
        )
    data = envelope.get("data")
    if not isinstance(data, dict):
        raise HTTPException(502, "TPCstore 返回数据无效")
    return data


async def read_studio_source(
    db: AsyncSession,
    project_id: str,
    file_id: str,
    kind: str,
    user_id: str,
) -> dict[str, str]:
    # 提取会向已配置的模型发送资料，要求项目写权限；只读成员不能发起新制作。
    await require_project_for_user(db, project_id, user_id, min_perm="write")
    if kind == "output":
        row = (
            await db.execute(
                select(OutputAsset).where(
                    OutputAsset.id == file_id,
                    OutputAsset.project_id == project_id,
                    OutputAsset.status != "archived",
                )
            )
        ).scalar_one_or_none()
        if row is None:
            raise HTTPException(404, "项目文件不存在")
        text, title, version = (
            str(row.content or ""),
            str(row.title or "项目输出"),
            str(row.version or "1"),
        )
    else:
        attachment = (
            await db.execute(
                select(ProjectAttachment).where(
                    ProjectAttachment.id == file_id,
                    ProjectAttachment.project_id == project_id,
                )
            )
        ).scalar_one_or_none()
        if attachment is None:
            raise HTTPException(404, "项目附件不存在")
        root = _attachments_root()
        path = (root / (attachment.stored_path or "")).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise HTTPException(404, "项目附件文件不可用")
        if path.suffix.lower() not in {".md", ".markdown", ".txt", ".pdf", ".docx"}:
            raise HTTPException(
                422, "首轮通路仅支持 Markdown、TXT、PDF、DOCX，不执行 OCR"
            )
        if path.stat().st_size > 8 * 1024 * 1024:
            raise HTTPException(413, "附件超过首轮 8 MiB 限制")
        from backend.services.document_extract import (
            DocumentExtractError,
            extract_to_markdown,
        )

        try:
            text = await asyncio.to_thread(
                extract_to_markdown,
                path,
                content_type=str(attachment.content_type)
                if attachment.content_type
                else None,
            )
        except DocumentExtractError as exc:
            raise HTTPException(422, "附件解析失败，请检查文件或选择文本资料") from exc
        title, version = str(attachment.original_filename or "项目附件"), ""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if not text.strip():
        raise HTTPException(422, "所选资料没有可读正文")
    if len(text) > 20000:
        raise HTTPException(
            413, "资料超过首轮 20000 字符上限；未截断提取，请选择更小的资料"
        )
    digest = hashlib.sha256(text.encode()).hexdigest()
    return {
        "project_id": project_id,
        "id": file_id,
        "kind": kind,
        "title": title,
        "version": version or digest,
        "sha256": digest,
        "text": text,
    }
