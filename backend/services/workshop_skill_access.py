"""工坊技能可见性与执行权限校验。"""
from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.orchestration_run import OrchestrationRun
from backend.services.skill_lifecycle import SkillLifecycleService
from backend.services.skill_loader import get_loader

logger = logging.getLogger("tpdx.hermes.workshop.skills")


async def visible_workshop_skill_names(
    db: AsyncSession,
    viewer_user_id: str,
    *,
    enabled_only: bool = True,
    require_loadable: bool = True,
) -> set[str]:
    """
    返回用户在工坊可见的技能名集合。

    - 按 DB owner_id / 管理员权限过滤（复用 SkillLifecycleService）
    - 可选要求技能在当前文件系统可加载（discover 命中）
    """
    svc = SkillLifecycleService(db, get_loader())
    rows = await svc.list_skills(enabled_only=enabled_only, viewer_user_id=viewer_user_id)
    names = {str(item.get("name") or "").strip() for item in rows if str(item.get("name") or "").strip()}
    if not require_loadable:
        return names
    loadable = set(get_loader().discover())
    return names & loadable


async def workshop_skill_accessible(
    db: AsyncSession,
    *,
    viewer_user_id: str,
    skill_name: str,
    enabled_only: bool = True,
) -> bool:
    visible = await visible_workshop_skill_names(
        db,
        viewer_user_id,
        enabled_only=enabled_only,
        require_loadable=True,
    )
    return skill_name in visible


async def workshop_viewer_user_id_from_context(
    db: AsyncSession,
    context: dict[str, Any] | None,
) -> str | None:
    """
    从工具 context 中解析 run_id 对应的执行用户。

    仅在携带 tphermes_run_id 时返回用户，避免误将无上下文调用强绑到 default。
    """
    rid = str((context or {}).get("tphermes_run_id") or "").strip()
    if not rid:
        return None
    row = await db.execute(
        select(OrchestrationRun.user_id).where(OrchestrationRun.id == rid)
    )
    user_id = row.scalar_one_or_none()
    if isinstance(user_id, str) and user_id.strip():
        return user_id.strip()
    logger.warning("workshop_skill_access run user not found run_id=%s", rid)
    return None
