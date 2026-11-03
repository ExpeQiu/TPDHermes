"""共创房间的写入合同与引用装载。服务端解析，不信任客户端扩展字段。"""

from __future__ import annotations

import logging
import os
import re
from typing import Any

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.output_asset import OutputAsset
from backend.models.project_attachment import ProjectAttachment
from backend.services.project_files_service import (
    REFERENCED_ATTACHMENT_MAX_CHARS,
    REFERENCED_OUTPUT_MAX_CHARS,
    REFERENCED_TOTAL_MAX_CHARS,
    get_project_file_detail,
)

logger = logging.getLogger("tpdx.hermes.co_create_room")

_DENY_WRITE_RE = re.compile(r"不要(生成|写|落稿|输出|创建|修订)|别写|不要生成文档|不要写文档")
_EXPLICIT_WRITE_RE = re.compile(r"写一版|写一稿|生成|修订|改写|起草|成稿|产出|落稿|删除原句|正式稿")
_PLAN_CONFIRM_RE = re.compile(
    r"^(确认(执行|计划)?|开始执行|按计划执行|执行计划|继续执行|ok|go|yes)$",
    re.I,
)

READ_ONLY_REASON = {"ask", "plan_draft", "denied", "no_plan", "stale_plan", "unclear", "archived"}


def writer_driver_name() -> str:
    return os.getenv("ROOM_WRITER_DRIVER", "hermes").strip().lower() or "hermes"


def is_plan_confirm(text: str) -> bool:
    return bool(_PLAN_CONFIRM_RE.match((text or "").strip()))


def denies_write(text: str) -> bool:
    return bool(_DENY_WRITE_RE.search(text or ""))


def explicit_write_intent(text: str) -> bool:
    if denies_write(text):
        return False
    return bool(_EXPLICIT_WRITE_RE.search(text or ""))


def allows_file_write(
    *,
    mode: str,
    text: str,
    has_plan: bool,
    plan_version: int,
    confirm_plan_version: int | None,
    archived: bool,
) -> tuple[bool, str]:
    """Ask、未确认 Plan、否定写入、过期确认都不能落稿。"""
    if archived:
        return False, "archived"
    if denies_write(text):
        return False, "denied"
    resolved = (mode or "agent").strip().lower()
    if resolved == "ask":
        return False, "ask"
    if is_plan_confirm(text):
        if not has_plan or plan_version <= 0:
            return False, "no_plan"
        if confirm_plan_version is not None and int(confirm_plan_version) != int(plan_version):
            return False, "stale_plan"
        return True, "plan_confirmed"
    if resolved == "plan":
        return False, "plan_draft"
    if resolved == "agent" and explicit_write_intent(text):
        return True, "explicit"
    return False, "unclear"


def delivery_document(title: str, delivery: str) -> str:
    body = (delivery or "").strip()
    if not body:
        raise ValueError("主笔没有交付正文")
    if body.startswith("#"):
        return body if body.endswith("\n") else body + "\n"
    return f"# {title}\n\n{body}\n"


def _trim(text: str, limit: int) -> tuple[str, bool]:
    raw = (text or "").strip()
    if len(raw) <= limit:
        return raw, False
    return raw[:limit] + "\n…（已截断）", True


async def _output_in_other_project(db: AsyncSession, file_id: str, project_id: str) -> bool:
    row = await db.get(OutputAsset, file_id)
    return bool(row and row.project_id != project_id)


async def _attachment_in_other_project(db: AsyncSession, file_id: str, project_id: str) -> bool:
    row = await db.get(ProjectAttachment, file_id)
    return bool(row and row.project_id != project_id)


async def resolve_room_files(
    db: AsyncSession,
    *,
    project_id: str,
    files: list[dict[str, Any]] | None,
    mention_file_ids: list[str] | None,
) -> list[dict[str, Any]]:
    """校验归属后装载正文。无权文件不返回标题。跨项目在共享规则确定前拒绝。"""
    refs: list[dict[str, Any]] = []
    for item in files or []:
        if not isinstance(item, dict):
            continue
        refs.append(
            {
                "project_id": str(item.get("project_id") or project_id),
                "file_id": str(item.get("file_id") or "").strip(),
                "kind": str(item.get("kind") or "output").strip() or "output",
                "version": str(item.get("version") or "").strip(),
                "purpose": str(item.get("purpose") or "material").strip() or "material",
            }
        )
    for file_id in mention_file_ids or []:
        cleaned = str(file_id).strip()
        if not cleaned:
            continue
        if any(ref["file_id"] == cleaned for ref in refs):
            continue
        refs.append(
            {
                "project_id": project_id,
                "file_id": cleaned,
                "kind": "output",
                "version": "",
                "purpose": "material",
            }
        )

    resolved: list[dict[str, Any]] = []
    total = 0
    for ref in refs:
        if not ref["file_id"]:
            raise HTTPException(status_code=400, detail="文件引用缺少 file_id")
        if ref["project_id"] != project_id:
            logger.info(
                "[co-create-room] cross project file refused room_project=%s file_project=%s file_id=%s",
                project_id,
                ref["project_id"],
                ref["file_id"],
            )
            raise HTTPException(status_code=403, detail="跨项目材料未授权，不能进入共享群聊")
        kind = ref["kind"]
        if kind not in {"output", "attachment"}:
            raise HTTPException(status_code=400, detail="不支持的文件类型")
        foreign = (
            await _output_in_other_project(db, ref["file_id"], project_id)
            if kind == "output"
            else await _attachment_in_other_project(db, ref["file_id"], project_id)
        )
        if foreign:
            logger.info(
                "[co-create-room] foreign file hidden project_id=%s file_id=%s kind=%s",
                project_id,
                ref["file_id"],
                kind,
            )
            raise HTTPException(status_code=404, detail="无权访问该文件")
        detail = await get_project_file_detail(db, project_id, ref["file_id"], kind)
        if not detail:
            if kind == "output":
                detail = await get_project_file_detail(db, project_id, ref["file_id"], "attachment")
                kind = "attachment" if detail else kind
            elif kind == "attachment":
                detail = await get_project_file_detail(db, project_id, ref["file_id"], "output")
                kind = "output" if detail else kind
        if not detail:
            raise HTTPException(status_code=404, detail="无权访问该文件")
        limit = REFERENCED_OUTPUT_MAX_CHARS if kind == "output" else REFERENCED_ATTACHMENT_MAX_CHARS
        excerpt, truncated = _trim(str(detail.get("content") or ""), limit)
        remain = REFERENCED_TOTAL_MAX_CHARS - total
        if remain <= 0:
            truncated = True
            excerpt = ""
        elif len(excerpt) > remain:
            excerpt = excerpt[:remain] + "\n…（已截断）"
            truncated = True
        total += len(excerpt)
        version = str(detail.get("version") or ref["version"] or "")
        resolved.append(
            {
                "project_id": project_id,
                "file_id": ref["file_id"],
                "kind": kind,
                "version": version,
                "purpose": ref["purpose"],
                "title": str(detail.get("title") or ""),
                "excerpt": excerpt,
                "truncated": truncated,
            }
        )
        logger.info(
            "[co-create-room] file resolved project_id=%s file_id=%s kind=%s purpose=%s chars=%s truncated=%s",
            project_id,
            ref["file_id"],
            kind,
            ref["purpose"],
            len(excerpt),
            truncated,
        )
    return resolved
