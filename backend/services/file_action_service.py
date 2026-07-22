"""Agent 文件动作：解析提案与应用写回。"""

from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.output_asset import OutputAsset
from backend.services.file_patch_utils import normalize_patch_action_fields, resolve_patch_content
from backend.services.project_kb_ingest import schedule_ingest_output

logger = logging.getLogger("tpdx.hermes.file_actions")

FILE_ACTIONS_BLOCK_RE = re.compile(
    r"```tphermes_file_actions\s*\n([\s\S]*?)```",
    re.MULTILINE,
)


def normalize_create_file_path(file_name: str, raw_path: str = "") -> str:
    """Hermes 沙箱绝对路径 → TPD 项目虚拟路径 /输出/…"""
    name = (file_name or "自动创建文稿.md").strip() or "自动创建文稿.md"
    if not name.lower().endswith(".md"):
        name = f"{name}.md"
    path = (raw_path or "").strip()
    if path.startswith("/输出/"):
        return path
    if path.startswith(("/Users/", "/home/")) or (len(path) > 2 and path[1] == ":"):
        return f"/输出/{name}"
    if path.startswith("/") and not path.startswith("/输出"):
        return f"/输出/{name}"
    return f"/输出/{name}"


def _parse_patch_action(item: dict[str, Any], proposal_id: str) -> dict[str, Any]:
    patch_fields = normalize_patch_action_fields(item)
    edit_mode = patch_fields["edit_mode"]
    row: dict[str, Any] = {
        "proposal_id": proposal_id,
        "type": "patch",
        "file_id": str(item.get("fileId") or item.get("file_id") or ""),
        "file_kind": str(item.get("fileKind") or item.get("file_kind") or "output"),
        "file_name": str(item.get("fileName") or item.get("file_name") or ""),
        "summary": str(item.get("summary") or "文件修改"),
        "before": str(item.get("before") or ""),
        "after": str(item.get("after") or item.get("content") or ""),
        "edit_mode": edit_mode,
        "old_string": patch_fields["old_string"],
        "new_string": patch_fields["new_string"],
        "replace_all": patch_fields["replace_all"],
        "start_line": patch_fields["start_line"],
        "end_line": patch_fields["end_line"],
        "new_text": patch_fields["new_text"],
    }
    if edit_mode == "search_replace" and patch_fields["new_string"] and not row["after"]:
        row["after"] = patch_fields["new_string"]
    if edit_mode == "line_range" and patch_fields["new_text"] and not row["after"]:
        row["after"] = patch_fields["new_text"]
    return row


def parse_file_actions_from_content(content: str) -> list[dict[str, Any]]:
    match = FILE_ACTIONS_BLOCK_RE.search(content or "")
    if not match:
        return []
    try:
        data = json.loads(match.group(1).strip())
        actions = data.get("actions") if isinstance(data, dict) else data
        if not isinstance(actions, list):
            return []
        out: list[dict[str, Any]] = []
        for item in actions:
            if not isinstance(item, dict):
                continue
            action_type = str(item.get("type") or "").strip()
            if action_type not in ("create", "patch"):
                continue
            proposal_id = str(item.get("proposalId") or item.get("proposal_id") or uuid.uuid4())
            if action_type == "create":
                file_name = str(item.get("fileName") or item.get("file_name") or "新文件.md")
                raw_path = str(item.get("path") or "/")
                out.append(
                    {
                        "proposal_id": proposal_id,
                        "type": "create",
                        "file_name": file_name,
                        "path": normalize_create_file_path(file_name, raw_path),
                        "content": str(item.get("content") or ""),
                    }
                )
            else:
                out.append(_parse_patch_action(item, proposal_id))
        return out
    except json.JSONDecodeError:
        logger.warning("[file-actions] JSON 解析失败")
        return []


def _parse_version_num(raw: str | None) -> int:
    try:
        return int((raw or "1").strip())
    except ValueError:
        return 1


def normalize_output_title(file_name: str) -> str:
    """create 落库 title 规范化，便于同项目同名 upsert。"""
    title = (file_name or "新文件.md").strip() or "新文件.md"
    if not title.lower().endswith(".md"):
        title = f"{title}.md"
    return title


def _title_stem(title: str | None) -> str:
    """比较用 stem：忽略大小写与 .md / .markdown 后缀。"""
    t = (title or "").strip().lower()
    if t.endswith(".markdown"):
        return t[:-9].strip()
    if t.endswith(".md"):
        return t[:-3].strip()
    return t


async def find_active_output_by_title(
    db: AsyncSession,
    project_id: str,
    file_name: str,
) -> OutputAsset | None:
    title = normalize_output_title(file_name)
    stem = _title_stem(title)
    q = await db.execute(
        select(OutputAsset)
        .where(
            OutputAsset.project_id == project_id,
            OutputAsset.status != "archived",
        )
        .order_by(OutputAsset.updated_at.desc())
    )
    rows = q.scalars().all()
    for row in rows:
        if (row.title or "").strip() == title:
            return row
    for row in rows:
        if _title_stem(row.title) == stem:
            logger.info(
                "[file-actions] title stem match project_id=%s requested=%s matched=%s output_id=%s",
                project_id,
                title,
                row.title,
                row.id,
            )
            return row
    return None


def _build_output_row(
    prev: OutputAsset,
    *,
    project_id: str,
    content: str,
    version: str,
    status: str,
    effective_uid: str,
    now: str,
    title: str | None = None,
) -> OutputAsset:
    return OutputAsset(
        id=str(uuid.uuid4()),
        project_id=project_id,
        scenario_id=getattr(prev, "scenario_id", None),
        template_id=prev.template_id,
        run_id=prev.run_id,
        title=title if title is not None else prev.title,
        summary=(content or "")[:280],
        content=content,
        content_format=prev.content_format or "markdown",
        version=version,
        status=status,
        citations_json=prev.citations_json,
        owner_id=effective_uid or getattr(prev, "owner_id", None) or "default",
        created_at=now,
        updated_at=now,
    )


async def _reload_output_after_commit(db: AsyncSession, output_id: str) -> OutputAsset:
    """commit 后重新加载行，避免 aiosqlite 下 db.refresh 偶发失败。"""
    row = await db.get(OutputAsset, output_id)
    if not row:
        raise ValueError(f"文件落库后读取失败: {output_id}")
    return row


async def _persist_patched_output(
    db: AsyncSession,
    *,
    prev: OutputAsset,
    project_id: str,
    content: str,
    action: dict[str, Any],
    effective_uid: str,
    now: str,
) -> dict[str, Any]:
    save_mode = str(action.get("save_mode") or "overwrite").strip()
    if save_mode == "overwrite":
        previous_content = prev.content or ""
        file_id = prev.id
        next_version = prev.version or "1"
        raw_title = action.get("file_name") or action.get("fileName")
        new_title = normalize_output_title(str(raw_title)) if raw_title else None
        title_changed = Boolean(new_title and new_title != (prev.title or "").strip())
        content_changed = previous_content != content
        if content_changed:
            if previous_content.strip():
                snapshot_version = str(_parse_version_num(prev.version))
                snapshot = _build_output_row(
                    prev,
                    project_id=project_id,
                    content=previous_content,
                    version=snapshot_version,
                    status="archived",
                    effective_uid=effective_uid,
                    now=now,
                )
                db.add(snapshot)
                logger.info(
                    "[file-actions] overwrite 已归档历史版本 output_id=%s version=%s project_id=%s",
                    snapshot.id,
                    snapshot_version,
                    project_id,
                )
            next_version = str(_parse_version_num(prev.version) + 1)
            prev.version = next_version
            prev.content = content
            prev.summary = content[:280]
            prev.updated_at = now
        if title_changed and new_title:
            prev.title = new_title
            prev.updated_at = now
            logger.info(
                "[file-actions] overwrite 已更新标题 output_id=%s title=%s project_id=%s",
                file_id,
                new_title,
                project_id,
            )
        await db.commit()
        persisted = await _reload_output_after_commit(db, file_id)
        schedule_ingest_output(persisted.id)
        return {
            "ok": True,
            "file_id": persisted.id,
            "kind": "output",
            "version": persisted.version or next_version,
            "title": persisted.title,
        }
    vnum = _parse_version_num(prev.version) + 1
    title = str(action.get("file_name") or action.get("fileName") or prev.title or "未命名")
    if save_mode == "copy":
        title = f"{title}（副本）"
    new_row = _build_output_row(
        prev,
        project_id=project_id,
        content=content,
        version=str(vnum),
        status=prev.status,
        effective_uid=effective_uid,
        now=now,
        title=title,
    )
    new_id = new_row.id
    db.add(new_row)
    await db.commit()
    persisted = await _reload_output_after_commit(db, new_id)
    schedule_ingest_output(persisted.id)
    return {"ok": True, "file_id": persisted.id, "kind": "output", "version": persisted.version}


async def apply_file_action(
    db: AsyncSession,
    project_id: str,
    *,
    effective_uid: str,
    action: dict[str, Any],
    session_id: str | None = None,
    message_id: str | None = None,
    proposal_id: str | None = None,
) -> dict[str, Any]:
    action_type = action.get("type")
    now = datetime.now().isoformat()
    edit_mode = str(action.get("edit_mode") or action.get("editMode") or "full")
    logger.info(
        "[file-actions] apply project_id=%s type=%s edit_mode=%s proposal_id=%s session_id=%s",
        project_id,
        action_type,
        edit_mode,
        proposal_id,
        session_id,
    )

    if action_type == "create":
        content = str(action.get("content") or "").strip()
        if not content:
            raise ValueError("创建文件内容不能为空")
        title = normalize_output_title(str(action.get("file_name") or action.get("fileName") or "新文件.md"))
        existing = await find_active_output_by_title(db, project_id, title)
        if existing:
            if (existing.title or "").strip() != title:
                existing.title = title
            logger.info(
                "[file-actions] create upsert project_id=%s title=%s output_id=%s proposal_id=%s",
                project_id,
                title,
                existing.id,
                proposal_id,
            )
            return await _persist_patched_output(
                db,
                prev=existing,
                project_id=project_id,
                content=content,
                action={"save_mode": "overwrite", "file_name": title},
                effective_uid=effective_uid,
                now=now,
            )
        row = OutputAsset(
            id=str(uuid.uuid4()),
            project_id=project_id,
            title=title,
            summary=content[:280],
            content=content,
            content_format="markdown",
            status="draft",
            owner_id=effective_uid or "default",
            created_at=now,
            updated_at=now,
        )
        row_id = row.id
        db.add(row)
        await db.commit()
        persisted = await _reload_output_after_commit(db, row_id)
        schedule_ingest_output(persisted.id)
        logger.info(
            "[file-actions] create insert project_id=%s title=%s output_id=%s proposal_id=%s",
            project_id,
            title,
            persisted.id,
            proposal_id,
        )
        return {"ok": True, "file_id": persisted.id, "kind": "output", "version": persisted.version}

    if action_type == "patch":
        target_kind = str(
            action.get("target_kind") or action.get("file_kind") or action.get("fileKind") or "output"
        ).strip()
        if target_kind == "attachment":
            raise ValueError("上传附件不可直接修改，请创建或修改输出物（/输出/）")
        file_id = str(action.get("target_file_id") or action.get("file_id") or "").strip()
        if not file_id:
            raise ValueError("修改目标文件 ID 不能为空")
        q = await db.execute(
            select(OutputAsset).where(
                OutputAsset.id == file_id,
                OutputAsset.project_id == project_id,
            )
        )
        prev = q.scalar_one_or_none()
        if not prev:
            raise ValueError(f"目标输出不存在: {file_id}")
        previous_content = prev.content or ""
        content = resolve_patch_content(previous_content, action)
        return await _persist_patched_output(
            db,
            prev=prev,
            project_id=project_id,
            content=content,
            action=action,
            effective_uid=effective_uid,
            now=now,
        )

    raise ValueError(f"不支持的动作类型: {action_type}")
