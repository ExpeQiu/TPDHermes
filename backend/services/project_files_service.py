"""项目文件域服务：聚合 outputs + attachments 为统一文件视图。"""

from __future__ import annotations

import logging
import mimetypes
import os
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.output_asset import OutputAsset
from backend.models.project_attachment import ProjectAttachment

logger = logging.getLogger("tpdx.hermes.project_files")

ATTACHMENTS_ROOT_ENV = "PROJECT_UPLOAD_DIR"
REFERENCED_OUTPUT_MAX_CHARS = max(800, int(os.getenv("CO_CREATE_REF_OUTPUT_MAX_CHARS", "4000")))
REFERENCED_ATTACHMENT_MAX_CHARS = max(
    400, int(os.getenv("CO_CREATE_REF_ATTACHMENT_MAX_CHARS", "2000"))
)
REFERENCED_TOTAL_MAX_CHARS = max(2000, int(os.getenv("CO_CREATE_REF_TOTAL_MAX_CHARS", "12000")))
REFERENCED_FILE_LIMIT = max(1, int(os.getenv("CO_CREATE_REF_FILE_LIMIT", "4")))
ATTACHMENT_PREVIEW_MAX_CHARS = 50_000


def _attachments_root() -> Path:
    override = os.getenv(ATTACHMENTS_ROOT_ENV, "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return (Path(__file__).resolve().parent.parent / "data" / "project_uploads").resolve()


def _guess_file_type(name: str, content_format: str | None = None) -> str:
    if content_format:
        return content_format
    ext = Path(name).suffix.lower()
    if ext in (".md", ".markdown"):
        return "markdown"
    if ext == ".json":
        return "json"
    if ext == ".txt":
        return "text"
    if ext == ".pdf":
        return "pdf"
    if ext in (".png", ".jpg", ".jpeg", ".gif", ".webp"):
        return "image"
    mime, _ = mimetypes.guess_type(name)
    return mime or "binary"


def _output_path(title: str | None) -> str:
    t = (title or "未命名输出").strip()
    if not t.startswith("/"):
        return f"/输出/{t}"
    return t


def _attachment_path(filename: str) -> str:
    return f"/附件/{filename}"


def _read_attachment_preview_content(path: Path, *, content_type: str | None) -> tuple[str, str]:
    """将附件抽取为可预览文本，返回 (content, content_format)。"""
    from backend.services.document_extract import DocumentExtractError, extract_to_markdown

    if not path.is_file():
        logger.warning("[project-files] attachment preview file missing path=%s", path)
        return "（附件文件不存在或已被删除，请重新上传。）", "text"

    try:
        text = (extract_to_markdown(path, content_type=content_type) or "").strip()
    except DocumentExtractError as exc:
        err = str(exc)
        logger.warning("[project-files] attachment preview extract failed path=%s err=%s", path, err)
        if err.startswith("unsupported_format"):
            suffix = path.suffix or "此格式"
            return f"（暂不支持在线预览 {suffix} 文件，请下载原文件查看。）", "text"
        if err == "pymupdf_not_installed":
            return "（PDF 预览依赖未安装，请联系管理员。）", "text"
        if err == "python_docx_not_installed":
            return "（Word 预览依赖未安装，请联系管理员。）", "text"
        return f"（预览失败：{err}，请下载原文件查看。）", "text"

    if not text:
        return "（文件为空或无法提取可读文本。）", "text"

    if len(text) > ATTACHMENT_PREVIEW_MAX_CHARS:
        text = text[:ATTACHMENT_PREVIEW_MAX_CHARS] + "\n\n…（预览已截断）"

    suffix = path.suffix.lower()
    content_format = "markdown" if suffix in {".md", ".markdown", ".pdf", ".docx"} else "text"
    return text, content_format


async def list_project_files(db: AsyncSession, project_id: str) -> list[dict]:
    outputs_q = await db.execute(
        select(OutputAsset)
        .where(OutputAsset.project_id == project_id, OutputAsset.status != "archived")
        .order_by(OutputAsset.updated_at.desc())
    )
    attachments_q = await db.execute(
        select(ProjectAttachment)
        .where(ProjectAttachment.project_id == project_id)
        .order_by(ProjectAttachment.created_at.desc())
    )
    items: list[dict] = []
    for row in outputs_q.scalars().all():
        items.append(
            {
                "id": row.id,
                "kind": "output",
                "title": (row.title or "未命名输出").strip(),
                "path": _output_path(row.title),
                "file_type": _guess_file_type(row.title or "", row.content_format),
                "status": row.status,
                "ref_state": "unselected",
                "updated_at": row.updated_at or row.created_at,
                "summary": (row.summary or "")[:200] or None,
                "created_at": row.created_at,
                "owner_id": (row.owner_id or "").strip() or None,
                "version": row.version,
            }
        )
    for row in attachments_q.scalars().all():
        name = row.original_filename or row.id
        items.append(
            {
                "id": row.id,
                "kind": "attachment",
                "title": name,
                "path": _attachment_path(name),
                "file_type": _guess_file_type(name),
                "status": row.ingest_status,
                "ref_state": "unselected",
                "updated_at": row.created_at,
                "summary": f"索引: {row.ingest_status}" if row.ingest_status else None,
                "created_at": row.created_at,
                "owner_id": None,
                "version": None,
            }
        )
    logger.info("[project-files] list project_id=%s count=%s", project_id, len(items))
    return items


async def get_project_file_detail(
    db: AsyncSession,
    project_id: str,
    file_id: str,
    kind: str,
) -> dict | None:
    if kind == "output":
        q = await db.execute(
            select(OutputAsset).where(
                OutputAsset.id == file_id,
                OutputAsset.project_id == project_id,
            )
        )
        row = q.scalar_one_or_none()
        if not row:
            return None
        return {
            "id": row.id,
            "kind": "output",
            "title": (row.title or "未命名输出").strip(),
            "path": _output_path(row.title),
            "file_type": _guess_file_type(row.title or "", row.content_format),
            "status": row.status,
            "content": row.content or "",
            "content_format": row.content_format or "markdown",
            "updated_at": row.updated_at,
            "created_at": row.created_at,
            "owner_id": (row.owner_id or "").strip() or None,
            "version": row.version,
        }
    if kind == "attachment":
        q = await db.execute(
            select(ProjectAttachment).where(
                ProjectAttachment.id == file_id,
                ProjectAttachment.project_id == project_id,
            )
        )
        row = q.scalar_one_or_none()
        if not row:
            return None
        path = _attachments_root() / (row.stored_path or "")
        content, content_format = _read_attachment_preview_content(
            path,
            content_type=row.content_type,
        )
        return {
            "id": row.id,
            "kind": "attachment",
            "title": row.original_filename or row.id,
            "path": _attachment_path(row.original_filename or row.id),
            "file_type": _guess_file_type(row.original_filename or ""),
            "status": row.ingest_status,
            "content": content,
            "content_format": content_format,
            "updated_at": row.created_at,
            "created_at": row.created_at,
            "owner_id": None,
            "version": None,
        }
    return None


async def list_output_versions(db: AsyncSession, project_id: str, output_id: str) -> list[dict]:
    q = await db.execute(
        select(OutputAsset).where(
            OutputAsset.id == output_id,
            OutputAsset.project_id == project_id,
        )
    )
    base = q.scalar_one_or_none()
    if not base:
        return []
    title = (base.title or "").strip()
    if not title:
        return [
            {
                "id": base.id,
                "version": base.version or "1",
                "title": base.title,
                "created_at": base.created_at,
                "updated_at": base.updated_at,
            }
        ]
    q2 = await db.execute(
        select(OutputAsset)
        .where(
            OutputAsset.project_id == project_id,
            OutputAsset.title == title,
        )
        .order_by(OutputAsset.created_at.desc())
    )
    rows = q2.scalars().all()
    if len(rows) <= 1:
        return [
            {
                "id": base.id,
                "version": base.version or "1",
                "title": base.title,
                "created_at": base.created_at,
                "updated_at": base.updated_at,
            }
        ]
    return [
        {
            "id": r.id,
            "version": r.version or "1",
            "title": r.title,
            "created_at": r.created_at,
            "updated_at": r.updated_at,
        }
        for r in rows
    ]


async def build_referenced_files_extra(
    db: AsyncSession,
    project_id: str,
    file_ids: list[str],
    pinned_ids: list[str] | None = None,
) -> str:
    """将结构化文件引用注入 task_input.extra 文本块。"""
    if not file_ids and not pinned_ids:
        return ""
    lines = ["【项目文件引用】"]
    seen: set[str] = set()
    total_chars = 0
    truncated_files = 0
    file_count = 0

    def trim_body(text: str, limit: int) -> tuple[str, bool]:
        raw = (text or "").strip()
        if len(raw) <= limit:
            return raw, False
        return raw[:limit] + "\n…（已截断）", True

    async def append_file(fid: str, label: str) -> None:
        nonlocal total_chars, truncated_files, file_count
        if fid in seen:
            return
        if file_count >= REFERENCED_FILE_LIMIT or total_chars >= REFERENCED_TOTAL_MAX_CHARS:
            return
        seen.add(fid)
        out_q = await db.execute(
            select(OutputAsset).where(
                OutputAsset.id == fid,
                OutputAsset.project_id == project_id,
            )
        )
        out = out_q.scalar_one_or_none()
        if out:
            body, truncated = trim_body(out.content or "", REFERENCED_OUTPUT_MAX_CHARS)
            chunk = f"\n{label} 输出物《{out.title or fid}》:\n{body}"
            remain = REFERENCED_TOTAL_MAX_CHARS - total_chars
            if remain <= 0:
                return
            if len(chunk) > remain:
                chunk = chunk[:remain] + "\n…（项目文件引用总量已截断）"
                truncated = True
            lines.append(chunk)
            total_chars += len(chunk)
            file_count += 1
            if truncated:
                truncated_files += 1
            return
        att_q = await db.execute(
            select(ProjectAttachment).where(
                ProjectAttachment.id == fid,
                ProjectAttachment.project_id == project_id,
            )
        )
        att = att_q.scalar_one_or_none()
        if att:
            detail = await get_project_file_detail(db, project_id, fid, "attachment")
            body = (detail or {}).get("content") or f"（附件 {att.original_filename}，请通过知识库检索）"
            trimmed, truncated = trim_body(str(body), REFERENCED_ATTACHMENT_MAX_CHARS)
            chunk = f"\n{label} 附件《{att.original_filename}》:\n{trimmed}"
            remain = REFERENCED_TOTAL_MAX_CHARS - total_chars
            if remain <= 0:
                return
            if len(chunk) > remain:
                chunk = chunk[:remain] + "\n…（项目文件引用总量已截断）"
                truncated = True
            lines.append(chunk)
            total_chars += len(chunk)
            file_count += 1
            if truncated:
                truncated_files += 1

    for fid in pinned_ids or []:
        await append_file(fid.strip(), "[固定引用]")
    for fid in file_ids or []:
        fid = fid.strip()
        if not fid or fid in seen:
            continue
        await append_file(fid, "[本轮引用]")
    if truncated_files > 0 or file_count >= REFERENCED_FILE_LIMIT:
        lines.append(
            f"\n[系统提示] 已注入 {file_count} 个引用文件；为控制首字延迟与上下文规模，部分正文已截断。"
        )
    return "\n".join(lines)
