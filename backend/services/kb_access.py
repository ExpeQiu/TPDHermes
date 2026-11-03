"""知识库访问边界：主体、项目、集合、上传路径、出站地址。"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.services.kb_proxy import CHROMA_HOST
from backend.services.project_access import require_project_for_user
from backend.services.project_kb import is_project_kb_collection, project_id_from_kb_collection
from backend.services.project_member_service import list_member_project_ids
from backend.services.rbac import SYSTEM_ADMIN_ROLES, resolve_platform_role
from backend.services.user_identity import is_global_admin_user

log = logging.getLogger("tpdx.hermes.kb_access")

SHARED_PROJECT_IDS = {"", "__all__", "*", "all"}
_ON = {"1", "true", "yes", "on"}


def _flag(name: str) -> bool:
    return os.getenv(name, "0").strip().lower() in _ON


def allow_client_chroma_url() -> bool:
    return _flag("TPDHERMES_ALLOW_CLIENT_CHROMA_URL")


def upload_root() -> Path:
    raw = os.getenv("KB_UPLOAD_DIR", str(Path("./data/kb_uploads").resolve()))
    return Path(raw).expanduser().resolve()


def reject_client_chroma_url(value: str | None) -> str:
    """普通客户端不能指定任意 Chroma 地址。省略时用服务端配置。"""
    raw = (value or "").strip()
    if not raw:
        return CHROMA_HOST
    if raw == CHROMA_HOST or allow_client_chroma_url():
        return raw
    log.warning("kb rejected client chroma_url")
    raise HTTPException(status_code=400, detail="不允许由客户端指定 chroma_url")


def assert_ingest_file(file_path: str) -> Path:
    """解析后的路径必须落在上传根目录内，拒绝符号链接。"""
    raw = Path(str(file_path)).expanduser()
    if raw.is_symlink():
        log.warning("kb ingest symlink rejected path=%s", raw)
        raise PermissionError("symlink_rejected")
    resolved = raw.resolve()
    root = upload_root()
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        log.warning("kb ingest path outside root path=%s root=%s", resolved, root)
        raise PermissionError("path_outside_upload_root") from exc
    if not resolved.is_file():
        raise FileNotFoundError(str(resolved))
    return resolved


def _concrete_project(project_id: str | None) -> str:
    return str(project_id or "").strip()


def is_shared_project(project_id: str | None) -> bool:
    return _concrete_project(project_id) in SHARED_PROJECT_IDS


async def _is_system_admin(db: AsyncSession, user_id: str) -> bool:
    if is_global_admin_user(user_id):
        return True
    role = await resolve_platform_role(db, None, user_id)
    return role in SYSTEM_ADMIN_ROLES


async def visible_cache_project_ids(db: AsyncSession, user_id: str) -> list[str] | None:
    """None 表示不限制。否则只含成员项目和共享库标记。"""
    if await _is_system_admin(db, user_id):
        return None
    member_ids = await list_member_project_ids(db, user_id)
    return list(member_ids) + ["__all__"]


async def authorize_kb_operation(
    db: AsyncSession,
    user_id: str,
    *,
    project_id: str | None,
    operation: str,
    collection: str | None = None,
) -> dict:
    """
    operation: read | write | manage
    项目资源走 require_project_for_user；共享库治理仅系统管理员。
    """
    actor = (user_id or "").strip() or "default"
    col = (collection or "").strip()
    pid = _concrete_project(project_id)
    admin = await _is_system_admin(db, actor)

    if col and is_project_kb_collection(col):
        col_pid = project_id_from_kb_collection(col) or ""
        if pid and not is_shared_project(pid) and col_pid and col_pid != pid:
            log.warning(
                "kb collection project mismatch actor=%s project=%s collection=%s",
                actor[:24],
                pid[:24],
                col,
            )
            raise HTTPException(status_code=404, detail="Project not found")
        if col_pid and is_shared_project(pid):
            pid = col_pid

    if is_shared_project(pid):
        if operation == "manage" and not admin:
            log.warning("kb shared manage denied actor=%s", actor[:24])
            raise HTTPException(status_code=403, detail="共享库治理需要管理权限")
        allowed = None if admin else await visible_cache_project_ids(db, actor)
        return {
            "actor": actor,
            "project_id": pid or "__all__",
            "collection": col,
            "allowed_project_ids": allowed,
            "admin": admin,
        }

    min_perm = "read"
    if operation == "write":
        min_perm = "write"
    elif operation == "manage":
        min_perm = "delete"
    await require_project_for_user(db, pid, actor, min_perm=min_perm)
    return {
        "actor": actor,
        "project_id": pid,
        "collection": col,
        "allowed_project_ids": [pid, "__all__"],
        "admin": admin,
    }
