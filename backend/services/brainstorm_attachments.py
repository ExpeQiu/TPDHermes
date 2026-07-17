"""头脑风暴附件上下文：抽取项目附件正文，供 multi-agent 圆桌注入（非 Hermes LLM）。"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.project_attachment import ProjectAttachment
from backend.services.document_extract import DocumentExtractError, extract_to_markdown

logger = logging.getLogger("tpdx.hermes.brainstorm.attachments")

ATTACHMENTS_ROOT_ENV = "PROJECT_UPLOAD_DIR"
DEFAULT_PER_FILE_CHARS = max(800, int(os.getenv("BRAINSTORM_ATTACHMENT_MAX_CHARS", "4000")))
DEFAULT_TOTAL_CHARS = max(2000, int(os.getenv("BRAINSTORM_ATTACHMENT_TOTAL_MAX_CHARS", "16000")))
DEFAULT_FILE_LIMIT = max(1, int(os.getenv("BRAINSTORM_ATTACHMENT_FILE_LIMIT", "6")))


def _attachments_root() -> Path:
    override = os.getenv(ATTACHMENTS_ROOT_ENV, "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return (Path(__file__).resolve().parent.parent / "data" / "project_uploads").resolve()


async def build_attachment_context(
    db: AsyncSession,
    *,
    project_id: str,
    attachment_ids: list[str],
) -> dict[str, Any]:
    """
    将勾选附件抽取为 Markdown 上下文。

    返回:
      context_markdown: 注入 multi-agent 的材料块（可空）
      items: 每条附件的索引状态摘要
    """
    ids = [str(x).strip() for x in attachment_ids if str(x).strip()]
    if not ids:
        return {"context_markdown": "", "items": []}

    # 保序去重，限制数量
    seen: set[str] = set()
    ordered: list[str] = []
    for aid in ids:
        if aid in seen:
            continue
        seen.add(aid)
        ordered.append(aid)
        if len(ordered) >= DEFAULT_FILE_LIMIT:
            break

    q = await db.execute(
        select(ProjectAttachment).where(
            ProjectAttachment.project_id == project_id,
            ProjectAttachment.id.in_(ordered),
        )
    )
    rows = {r.id: r for r in q.scalars().all()}
    root = _attachments_root()

    parts: list[str] = ["### 项目附件材料（供专家团研讨引用）", ""]
    items: list[dict[str, Any]] = []
    used = 0

    for aid in ordered:
        row = rows.get(aid)
        if not row:
            items.append({"id": aid, "status": "missing", "title": aid})
            logger.warning("头脑风暴附件不存在 | project=%s id=%s", project_id, aid)
            continue

        title = row.original_filename or aid
        ingest = (getattr(row, "ingest_status", None) or "").strip() or "pending"
        path = root / row.stored_path
        status = "ok"
        excerpt = ""
        err = None

        if not path.is_file():
            status = "file_missing"
            err = "文件丢失"
        else:
            try:
                text = (extract_to_markdown(path, content_type=row.content_type) or "").strip()
                if not text:
                    status = "empty"
                    err = "抽取结果为空"
                else:
                    budget = min(DEFAULT_PER_FILE_CHARS, max(200, DEFAULT_TOTAL_CHARS - used))
                    if len(text) > budget:
                        excerpt = text[:budget] + "…"
                    else:
                        excerpt = text
                    used += len(excerpt)
            except DocumentExtractError as exc:
                status = "extract_failed"
                err = str(exc)
                logger.warning(
                    "头脑风暴附件抽取失败 | project=%s id=%s err=%s",
                    project_id,
                    aid,
                    exc,
                )

        items.append(
            {
                "id": aid,
                "title": title,
                "status": status,
                "ingest_status": ingest,
                "kb_doc_id": getattr(row, "kb_doc_id", None),
                "chars": len(excerpt),
                "error": err,
            }
        )

        if excerpt:
            parts.append(f"#### {title}")
            if ingest == "ingested":
                parts.append(f"（已入库项目 KB · doc={getattr(row, 'kb_doc_id', '') or '—'}）")
            parts.append("")
            parts.append(excerpt)
            parts.append("")

        if used >= DEFAULT_TOTAL_CHARS:
            logger.info(
                "头脑风暴附件上下文达上限 | project=%s used=%s limit=%s",
                project_id,
                used,
                DEFAULT_TOTAL_CHARS,
            )
            break

    ok_n = sum(1 for i in items if i.get("status") == "ok" and (i.get("chars") or 0) > 0)
    context = "\n".join(parts).strip() if ok_n else ""
    logger.info(
        "头脑风暴附件上下文 | project=%s selected=%s ok=%s chars=%s",
        project_id,
        len(ordered),
        ok_n,
        len(context),
    )
    return {"context_markdown": context, "items": items}
