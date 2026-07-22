"""项目销毁：DB 级联 + 成员清理 + Chroma/磁盘外存回收。"""
from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path
from typing import Any

from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.project import Project
from backend.models.project_member import ProjectMember
from backend.services.kb_entry_manage import delete_kb_collection
from backend.services.kb_write import project_kb_md_root
from backend.services.project_kb import project_kb_collection

logger = logging.getLogger("tpdx.hermes.project_lifecycle")


def project_uploads_root() -> Path:
    """与 routes/projects、project_kb_ingest 一致，尊重 PROJECT_UPLOAD_DIR。"""
    override = os.getenv("PROJECT_UPLOAD_DIR", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return (Path(__file__).resolve().parent.parent / "data" / "project_uploads").resolve()


def project_kb_md_dirs_for_cleanup(project_id: str) -> list[Path]:
    """
    项目 KB 中间 md：以 `$KB_UPLOAD_DIR/project_kb/{id}` 为准，
    并兼容历史误写的 `backend/data/kb_upload/project_kb/{id}`。
    """
    pid = str(project_id).strip()
    dirs = [project_kb_md_root(pid)]
    legacy = (
        Path(__file__).resolve().parent.parent / "data" / "kb_upload" / "project_kb" / pid
    ).resolve()
    if legacy not in {d.resolve() for d in dirs}:
        dirs.append(legacy)
    return dirs


async def destroy_project(db: AsyncSession, project: Project) -> dict[str, Any]:
    """
    硬删除项目：
    - 删除 project_members（无 FK）
    - db.delete(project) 触发有 FK 的 CASCADE / SET NULL
    - 尽力删除 Chroma project.{id}.kb 与本地上传目录
    """
    pid = str(project.id)
    col = project_kb_collection(pid)
    report: dict[str, Any] = {
        "project_id": pid,
        "collection": col,
        "members_deleted": 0,
        "kb": None,
        "uploads_removed": False,
        "kb_files_removed": False,
        "kb_files_paths": [],
    }

    mem = await db.execute(delete(ProjectMember).where(ProjectMember.project_id == pid))
    report["members_deleted"] = int(mem.rowcount or 0)

    await db.delete(project)
    await db.commit()
    logger.info(
        "project destroyed id=%s members_deleted=%s",
        pid[:8],
        report["members_deleted"],
    )

    try:
        report["kb"] = await delete_kb_collection(collection=col, project_id=pid)
    except Exception as exc:  # noqa: BLE001
        logger.warning("project destroy kb cleanup failed project=%s err=%s", pid[:8], exc)
        report["kb"] = {"ok": False, "error": str(exc)}

    uploads = project_uploads_root() / pid
    if uploads.is_dir():
        shutil.rmtree(uploads, ignore_errors=True)
        report["uploads_removed"] = True
        logger.info("project uploads removed path=%s", uploads)

    removed_any = False
    for kb_files in project_kb_md_dirs_for_cleanup(pid):
        if kb_files.is_dir():
            shutil.rmtree(kb_files, ignore_errors=True)
            removed_any = True
            report["kb_files_paths"].append(str(kb_files))
            logger.info("project kb md removed path=%s", kb_files)
    report["kb_files_removed"] = removed_any

    return report
