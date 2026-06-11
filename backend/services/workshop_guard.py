"""Workshop 权限与执行合同校验。"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.orchestration_run import OrchestrationRun
from backend.services.project_access import require_project_for_user
from backend.services.project_kb import project_id_from_kb_collection
from backend.services.workshop_skill_access import workshop_skill_accessible


class WorkshopGuardError(Exception):
    """共享给 route/tool 层的工坊校验错误。"""

    def __init__(self, detail: str, *, status_code: int = 400):
        super().__init__(detail)
        self.detail = detail
        self.status_code = status_code


@dataclass(slots=True)
class WorkshopInvocation:
    run: OrchestrationRun
    run_id: str
    viewer_user_id: str
    project_id: str | None
    collection_name: str | None = None


def require_tphermes_run_id(run_id: str | None) -> str:
    rid = str(run_id or "").strip()
    if not rid:
        raise WorkshopGuardError("workshop 调用必须提供 tphermes_run_id", status_code=400)
    return rid


def _normalize_project_id(project_id: str | None) -> str | None:
    pid = str(project_id or "").strip()
    if not pid or pid == "none":
        return None
    return pid


async def require_workshop_run_for_user(
    db: AsyncSession,
    *,
    run_id: str,
    viewer_user_id: str | None = None,
) -> OrchestrationRun:
    row = await db.get(OrchestrationRun, run_id)
    if not row:
        raise WorkshopGuardError(f"运行不存在: {run_id}", status_code=404)
    uid = str(viewer_user_id or "").strip()
    owner = str(row.user_id or "").strip()
    if uid and owner and uid != owner:
        raise WorkshopGuardError("运行不存在或不可访问", status_code=404)
    return row


async def require_workshop_skill_for_user(
    db: AsyncSession,
    *,
    viewer_user_id: str,
    skill_name: str,
) -> str:
    name = str(skill_name or "").strip()
    if not name:
        raise WorkshopGuardError("skill_name 不能为空", status_code=400)
    allowed = await workshop_skill_accessible(
        db,
        viewer_user_id=viewer_user_id,
        skill_name=name,
        enabled_only=True,
    )
    if not allowed:
        raise WorkshopGuardError(f"技能不可用或不可见: {name}", status_code=400)
    return name


async def require_workshop_collection_for_user(
    db: AsyncSession,
    *,
    viewer_user_id: str,
    collection_name: str,
    project_id: str | None = None,
) -> str:
    name = str(collection_name or "").strip()
    if not name:
        raise WorkshopGuardError("collection_name 不能为空", status_code=400)
    run_project_id = _normalize_project_id(project_id)
    collection_project_id = project_id_from_kb_collection(name)
    if collection_project_id:
        await require_project_for_user(
            db,
            collection_project_id,
            viewer_user_id,
            detail="知识库集合不存在或不可访问",
        )
        if run_project_id and collection_project_id != run_project_id:
            raise WorkshopGuardError(
                f"知识库集合与当前运行项目不匹配: {name}",
                status_code=400,
            )
    return name


def ensure_single_workshop_skill_contract(skills: list[str] | None) -> str:
    names = [str(item or "").strip() for item in (skills or []) if str(item or "").strip()]
    if len(names) != 1:
        raise WorkshopGuardError(
            "工坊入口要求且仅允许绑定一个技能（skills.allowed 必须恰好 1 项）",
            status_code=400,
        )
    return names[0]


async def require_workshop_invocation(
    db: AsyncSession,
    *,
    tphermes_run_id: str,
    skill_name: str,
    viewer_user_id: str | None = None,
    project_id: str | None = None,
    collection_name: str | None = None,
) -> WorkshopInvocation:
    run_id = require_tphermes_run_id(tphermes_run_id)
    run = await require_workshop_run_for_user(
        db,
        run_id=run_id,
        viewer_user_id=viewer_user_id,
    )
    owner = str(run.user_id or "").strip()
    if not owner:
        raise WorkshopGuardError(f"运行缺少 user_id: {run_id}", status_code=400)

    requested_project_id = _normalize_project_id(project_id)
    run_project_id = _normalize_project_id(run.project_id)
    if requested_project_id and run_project_id and requested_project_id != run_project_id:
        raise WorkshopGuardError(
            "project_id 与 tphermes_run_id 对应运行不一致",
            status_code=400,
        )

    effective_project_id = requested_project_id or run_project_id
    if effective_project_id:
        await require_project_for_user(
            db,
            effective_project_id,
            owner,
            detail="项目不存在",
        )

    await require_workshop_skill_for_user(
        db,
        viewer_user_id=owner,
        skill_name=skill_name,
    )

    checked_collection: str | None = None
    if collection_name is not None:
        checked_collection = await require_workshop_collection_for_user(
            db,
            viewer_user_id=owner,
            collection_name=collection_name,
            project_id=effective_project_id,
        )

    return WorkshopInvocation(
        run=run,
        run_id=run_id,
        viewer_user_id=owner,
        project_id=effective_project_id,
        collection_name=checked_collection,
    )


def raise_http_if_workshop_guard_failed(exc: WorkshopGuardError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
