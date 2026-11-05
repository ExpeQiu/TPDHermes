"""Agent 文件动作：解析提案与应用写回。"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.output_asset import OutputAsset
from backend.models.project_file_domain import ProjectFileActionLog
from backend.services.file_patch_utils import normalize_patch_action_fields, resolve_patch_content
from backend.services.project_kb_ingest import schedule_ingest_output

logger = logging.getLogger("tpdx.hermes.file_actions")


class FileActionConflict(Exception):
    def __init__(self, current_version: str = "", *, reason: str = "version"):
        self.current_version = current_version
        self.reason = reason
        message = "文件版本已变化" if reason == "version" else "相同提案标识对应了不同内容"
        super().__init__(message)


class FileNameConflict(Exception):
    def __init__(self, file_id: str, title: str):
        self.file_id = file_id
        self.title = title
        super().__init__(f"同名文件已存在: {title}")


def _client_expected_version(action: dict[str, Any]) -> str | None:
    raw = action.get("base_version")
    if raw is None:
        raw = action.get("expected_version")
    if raw is None:
        return None
    text = str(raw).strip()
    return text or None


async def _claim_output_version(
    db: AsyncSession,
    *,
    file_id: str,
    project_id: str,
    version: str,
) -> None:
    """把版本比较和后续写入放在同一事务里：版本已变则本语句匹配 0 行。"""
    result = await db.execute(
        update(OutputAsset)
        .where(
            OutputAsset.id == file_id,
            OutputAsset.project_id == project_id,
            OutputAsset.version == version,
        )
        .values(version=version)
    )
    if result.rowcount == 0:
        fresh = await db.get(OutputAsset, file_id)
        current = str(fresh.version or "1") if fresh else "missing"
        logger.info(
            "[file-actions] version conflict project_id=%s output_id=%s expected=%s current=%s",
            project_id,
            file_id,
            version,
            current,
        )
        raise FileActionConflict(current)

FILE_ACTIONS_BLOCK_RE = re.compile(
    r"```TPCharness_file_actions\s*\n([\s\S]*?)```",
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
    """create 落库 title 规范化，便于同项目同名冲突判断。"""
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
        lineage_id=getattr(prev, "lineage_id", None) or prev.id,
    )


def _action_hash(action: dict[str, Any]) -> str:
    raw = json.dumps(action, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _explicit_overwrite(action: dict[str, Any]) -> bool:
    if action.get("on_conflict") == "overwrite":
        return True
    flag = action.get("overwrite")
    return flag is True or str(flag).lower() == "true"


def _lineage_of(row: OutputAsset) -> str:
    return str(getattr(row, "lineage_id", None) or row.id)


def _action_result(
    *,
    operation: str,
    save_mode: str,
    source_file_id: str | None,
    result_file_id: str,
    previous_version: str | None,
    result_version: str,
    title: str | None,
    previous_title: str | None = None,
) -> dict[str, Any]:
    return {
        "ok": True,
        "operation": operation,
        "save_mode": save_mode,
        "source_file_id": source_file_id,
        "result_file_id": result_file_id,
        "file_id": result_file_id,
        "previous_version": previous_version,
        "result_version": result_version,
        "version": result_version,
        "kind": "output",
        "title": title,
        "previous_title": previous_title,
    }


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
    current_version = str(prev.version or "1")
    expected = _client_expected_version(action)
    if expected is not None and expected != current_version:
        logger.info(
            "[file-actions] version conflict project_id=%s output_id=%s expected=%s current=%s",
            project_id,
            prev.id,
            expected,
            current_version,
        )
        raise FileActionConflict(current_version, reason="version")
    await _claim_output_version(
        db,
        file_id=prev.id,
        project_id=project_id,
        version=current_version,
    )
    if not prev.lineage_id:
        prev.lineage_id = prev.id
    if save_mode == "overwrite":
        previous_content = prev.content or ""
        previous_title = prev.title
        file_id = prev.id
        next_version = prev.version or "1"
        raw_title = action.get("file_name") or action.get("fileName")
        new_title = normalize_output_title(str(raw_title)) if raw_title else None
        title_changed = bool(new_title and new_title != (prev.title or "").strip())
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
        await db.flush()
        return _action_result(
            operation="patch",
            save_mode="overwrite",
            source_file_id=file_id,
            result_file_id=file_id,
            previous_version=current_version if (content_changed or title_changed) else current_version,
            result_version=str(prev.version or next_version),
            title=prev.title,
            previous_title=previous_title,
        )
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
    if save_mode == "copy":
        new_row.lineage_id = new_row.id
    new_id = new_row.id
    db.add(new_row)
    await db.flush()
    return _action_result(
        operation="patch",
        save_mode=save_mode,
        source_file_id=prev.id,
        result_file_id=new_id,
        previous_version=current_version,
        result_version=str(new_row.version or vnum),
        title=new_row.title,
        previous_title=prev.title,
    )


async def _replay_proposal(
    db: AsyncSession,
    *,
    project_id: str,
    proposal_id: str,
    payload_hash: str,
) -> dict[str, Any] | None:
    row = (
        await db.execute(
            select(ProjectFileActionLog).where(
                ProjectFileActionLog.project_id == project_id,
                ProjectFileActionLog.proposal_id == proposal_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        return None
    if (row.payload_hash or "") != payload_hash:
        logger.info(
            "[file-actions] proposal payload conflict project_id=%s proposal_id=%s",
            project_id,
            proposal_id,
        )
        raise FileActionConflict(reason="payload")
    if row.result_json:
        stored = json.loads(row.result_json)
        if isinstance(stored, dict):
            stored["action_id"] = row.id
            stored["idempotent_replay"] = True
            return stored
    return {"ok": True, "action_id": row.id, "idempotent_replay": True}


async def _claim_proposal(
    db: AsyncSession,
    *,
    project_id: str,
    proposal_id: str,
    payload_hash: str,
    action: dict[str, Any],
    effective_uid: str,
    session_id: str | None,
    message_id: str | None,
    now: str,
) -> ProjectFileActionLog | dict[str, Any]:
    replay = await _replay_proposal(
        db,
        project_id=project_id,
        proposal_id=proposal_id,
        payload_hash=payload_hash,
    )
    if replay is not None:
        return replay
    row = ProjectFileActionLog(
        id=str(uuid.uuid4()),
        project_id=project_id,
        session_id=session_id,
        message_id=message_id,
        proposal_id=proposal_id,
        action_type=str(action.get("type") or ""),
        target_file_id=str(action.get("target_file_id") or action.get("file_id") or "") or None,
        payload_json=json.dumps(action, ensure_ascii=False, default=str),
        payload_hash=payload_hash,
        status="pending",
        created_by=effective_uid or "default",
        created_at=now,
    )
    db.add(row)
    try:
        await db.flush()
    except IntegrityError:
        await db.rollback()
        replay = await _replay_proposal(
            db,
            project_id=project_id,
            proposal_id=proposal_id,
            payload_hash=payload_hash,
        )
        if replay is not None:
            return replay
        raise FileActionConflict(reason="payload")
    return row


async def apply_file_action(
    db: AsyncSession,
    project_id: str,
    *,
    effective_uid: str,
    action: dict[str, Any],
    session_id: str | None = None,
    message_id: str | None = None,
    proposal_id: str | None = None,
    commit: bool = True,
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
    proposal = (proposal_id or "").strip()
    payload_hash = _action_hash(action if isinstance(action, dict) else {})
    claimed: ProjectFileActionLog | None = None
    if proposal:
        claimed_or_replay = await _claim_proposal(
            db,
            project_id=project_id,
            proposal_id=proposal,
            payload_hash=payload_hash,
            action=action,
            effective_uid=effective_uid,
            session_id=session_id,
            message_id=message_id,
            now=now,
        )
        if isinstance(claimed_or_replay, dict):
            logger.info(
                "[file-actions] idempotent replay project_id=%s proposal_id=%s action_id=%s",
                project_id,
                proposal,
                claimed_or_replay.get("action_id"),
            )
            return claimed_or_replay
        claimed = claimed_or_replay

    if action_type == "create":
        content = str(action.get("content") or "").strip()
        if not content:
            raise ValueError("创建文件内容不能为空")
        title = normalize_output_title(str(action.get("file_name") or action.get("fileName") or "新文件.md"))
        existing = await find_active_output_by_title(db, project_id, title)
        if existing and not _explicit_overwrite(action):
            logger.info(
                "[file-actions] create name conflict project_id=%s title=%s output_id=%s proposal_id=%s",
                project_id,
                title,
                existing.id,
                proposal_id,
            )
            raise FileNameConflict(existing.id, existing.title or title)
        if existing:
            result = await _persist_patched_output(
                db,
                prev=existing,
                project_id=project_id,
                content=content,
                action={"save_mode": "overwrite", "file_name": title, "on_conflict": "overwrite"},
                effective_uid=effective_uid,
                now=now,
            )
            result["operation"] = "create"
            return await _finish_file_action(
                db,
                claimed=claimed,
                result=result,
                project_id=project_id,
                proposal_id=proposal,
                commit=commit,
            )
        row = OutputAsset(
            id=str(uuid.uuid4()),
            project_id=project_id,
            title=title,
            summary=content[:280],
            content=content,
            content_format="markdown",
            status="draft",
            version="1",
            owner_id=effective_uid or "default",
            created_at=now,
            updated_at=now,
            lineage_id=None,
        )
        row.lineage_id = row.id
        db.add(row)
        await db.flush()
        logger.info(
            "[file-actions] create insert project_id=%s title=%s output_id=%s proposal_id=%s",
            project_id,
            title,
            row.id,
            proposal_id,
        )
        result = _action_result(
            operation="create",
            save_mode="create",
            source_file_id=None,
            result_file_id=row.id,
            previous_version=None,
            result_version=str(row.version or "1"),
            title=row.title,
        )
        return await _finish_file_action(
            db,
            claimed=claimed,
            result=result,
            project_id=project_id,
            proposal_id=proposal,
            commit=commit,
        )

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
        result = await _persist_patched_output(
            db,
            prev=prev,
            project_id=project_id,
            content=content,
            action=action,
            effective_uid=effective_uid,
            now=now,
        )
        return await _finish_file_action(
            db,
            claimed=claimed,
            result=result,
            project_id=project_id,
            proposal_id=proposal,
            commit=commit,
        )

    raise ValueError(f"不支持的动作类型: {action_type}")


async def _finish_file_action(
    db: AsyncSession,
    *,
    claimed: ProjectFileActionLog | None,
    result: dict[str, Any],
    project_id: str,
    proposal_id: str,
    commit: bool = True,
) -> dict[str, Any]:
    if claimed is not None:
        claimed.status = "applied"
        claimed.result_file_id = result.get("result_file_id")
        claimed.target_file_id = result.get("source_file_id") or claimed.target_file_id
        result["action_id"] = claimed.id
        claimed.result_json = json.dumps(result, ensure_ascii=False)
    result_file_id = str(result.get("result_file_id") or "")
    if commit:
        await db.commit()
        if result_file_id:
            schedule_ingest_output(result_file_id)
        logger.info(
            "[file-actions] applied project_id=%s proposal_id=%s operation=%s result_file_id=%s version=%s",
            project_id,
            proposal_id,
            result.get("operation"),
            result_file_id,
            result.get("result_version"),
        )
    else:
        result["defer_ingest"] = True
        logger.info(
            "[file-actions] staged project_id=%s proposal_id=%s result_file_id=%s version=%s",
            project_id,
            proposal_id,
            result_file_id,
            result.get("result_version"),
        )
    return result


async def undo_file_action(
    db: AsyncSession,
    project_id: str,
    action_id: str,
    *,
    effective_uid: str,
) -> dict[str, Any]:
    row = await db.get(ProjectFileActionLog, action_id)
    if row is None or row.project_id != project_id:
        raise ValueError("动作不存在")
    if row.status == "undone":
        return {"ok": True, "action_id": action_id, "already_undone": True}
    if row.status != "applied" or not row.result_json:
        raise ValueError("动作尚未完成，不能撤销")
    result = json.loads(row.result_json)
    if not isinstance(result, dict):
        raise ValueError("动作结果无法撤销")
    result_file_id = str(result.get("result_file_id") or "")
    result_version = str(result.get("result_version") or "")
    target = await db.get(OutputAsset, result_file_id)
    if target is None or target.project_id != project_id:
        raise ValueError("撤销目标不存在")
    current_version = str(target.version or "1")
    if current_version != result_version:
        logger.info(
            "[file-actions] undo conflict project_id=%s action_id=%s expected=%s current=%s",
            project_id,
            action_id,
            result_version,
            current_version,
        )
        raise FileActionConflict(current_version)
    now = datetime.now().isoformat()
    operation = str(result.get("operation") or "")
    save_mode = str(result.get("save_mode") or "")
    if operation == "create" or save_mode in {"copy", "new_version"}:
        target.status = "archived"
        target.updated_at = now
    else:
        lineage = _lineage_of(target)
        previous_version = str(result.get("previous_version") or "")
        snap = (
            await db.execute(
                select(OutputAsset)
                .where(
                    OutputAsset.project_id == project_id,
                    OutputAsset.lineage_id == lineage,
                    OutputAsset.version == previous_version,
                    OutputAsset.status == "archived",
                )
                .order_by(OutputAsset.created_at.desc())
            )
        ).scalars().first()
        restored = snap.content if snap is not None else (target.content or "")
        previous_title = str(result.get("previous_title") or target.title or "")
        await _persist_patched_output(
            db,
            prev=target,
            project_id=project_id,
            content=restored,
            action={
                "save_mode": "overwrite",
                "file_name": previous_title,
                "base_version": result_version,
            },
            effective_uid=effective_uid,
            now=now,
        )
    row.status = "undone"
    await db.commit()
    logger.info(
        "[file-actions] undone project_id=%s action_id=%s operation=%s result_file_id=%s",
        project_id,
        action_id,
        operation,
        result_file_id,
    )
    return {"ok": True, "action_id": action_id, "undone": True, "result_file_id": result_file_id}
