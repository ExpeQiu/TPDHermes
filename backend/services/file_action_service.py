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
from backend.services.project_kb_ingest import schedule_ingest_output

logger = logging.getLogger("tpdx.hermes.file_actions")

FILE_ACTIONS_BLOCK_RE = re.compile(
    r"```tphermes_file_actions\s*\n([\s\S]*?)```",
    re.MULTILINE,
)


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
                out.append(
                    {
                        "proposal_id": proposal_id,
                        "type": "create",
                        "file_name": str(item.get("fileName") or item.get("file_name") or "新文件.md"),
                        "path": str(item.get("path") or "/"),
                        "content": str(item.get("content") or ""),
                    }
                )
            else:
                out.append(
                    {
                        "proposal_id": proposal_id,
                        "type": "patch",
                        "file_id": str(item.get("fileId") or item.get("file_id") or ""),
                        "file_kind": str(item.get("fileKind") or item.get("file_kind") or "output"),
                        "file_name": str(item.get("fileName") or item.get("file_name") or ""),
                        "summary": str(item.get("summary") or "文件修改"),
                        "before": str(item.get("before") or ""),
                        "after": str(item.get("after") or item.get("content") or ""),
                    }
                )
        return out
    except json.JSONDecodeError:
        logger.warning("[file-actions] JSON 解析失败")
        return []


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
    logger.info(
        "[file-actions] apply project_id=%s type=%s proposal_id=%s session_id=%s",
        project_id,
        action_type,
        proposal_id,
        session_id,
    )

    if action_type == "create":
        content = str(action.get("content") or "").strip()
        if not content:
            raise ValueError("创建文件内容不能为空")
        title = str(action.get("file_name") or action.get("fileName") or "新文件.md").strip()
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
        db.add(row)
        await db.commit()
        await db.refresh(row)
        schedule_ingest_output(row.id)
        return {"ok": True, "file_id": row.id, "kind": "output", "version": row.version}

    if action_type == "patch":
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
        content = str(action.get("content") or action.get("after") or "").strip()
        if not content:
            raise ValueError("修改内容不能为空")
        save_mode = str(action.get("save_mode") or "new_version").strip()
        if save_mode == "overwrite":
            prev.content = content
            prev.summary = content[:280]
            prev.updated_at = now
            await db.commit()
            await db.refresh(prev)
            schedule_ingest_output(prev.id)
            return {"ok": True, "file_id": prev.id, "kind": "output", "version": prev.version}
        try:
            vnum = int(prev.version or "1") + 1
        except ValueError:
            vnum = 2
        title = str(action.get("file_name") or prev.title or "未命名")
        if save_mode == "copy":
            title = f"{title}（副本）"
        new_row = OutputAsset(
            id=str(uuid.uuid4()),
            project_id=project_id,
            scenario_id=getattr(prev, "scenario_id", None),
            template_id=prev.template_id,
            run_id=prev.run_id,
            title=title,
            summary=content[:280],
            content=content,
            content_format=prev.content_format or "markdown",
            version=str(vnum),
            status=prev.status,
            citations_json=prev.citations_json,
            owner_id=effective_uid or getattr(prev, "owner_id", None) or "default",
            created_at=now,
            updated_at=now,
        )
        db.add(new_row)
        await db.commit()
        await db.refresh(new_row)
        schedule_ingest_output(new_row.id)
        return {"ok": True, "file_id": new_row.id, "kind": "output", "version": new_row.version}

    raise ValueError(f"不支持的动作类型: {action_type}")
