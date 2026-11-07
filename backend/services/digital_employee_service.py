"""数字员工档案、绑定、权限、检索摘录、飞书入站与钥匙。"""

from __future__ import annotations

import hashlib
import json
import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.digital_employee import (
    ConfirmationStep,
    DigitalEmployee,
    EmployeeCredential,
    EmployeeResourceBinding,
    EmployeeUsage,
    FeishuEmployeeBinding,
    FeishuInboundEvent,
    FeishuUserLink,
    ProjectEmployee,
)
from backend.models.orchestration_run import OrchestrationRun
from backend.models.project_member import ProjectMember

logger = logging.getLogger("tpdx.hermes.employees")

WORK_STYLES = (
    "目标明确",
    "证据优先",
    "动作可追溯",
    "事实先行",
    "流程推进",
    "风险克制",
    "及时追问",
)
EXPERTISE = (
    "业务问答",
    "技能执行",
    "工具调用",
    "资料检索",
    "文稿整理",
    "口径核对",
    "事务跟进",
)
WORK_MODES = (
    "识别意图",
    "补齐信息",
    "调用技能",
    "确认后执行",
    "转人工",
)
RESOURCE_TYPES = frozenset({"scenario", "skill", "knowledge", "template", "pack"})
EXCERPT_CHARS = 1200
EXCERPT_LIMIT = 8


class EmployeeAccessError(Exception):
    def __init__(self, detail: str, status_code: int = 403) -> None:
        self.detail = detail
        self.status_code = status_code


def _now() -> str:
    return datetime.now().isoformat()


def _loads(raw: str | None) -> list[str]:
    try:
        data = json.loads(raw or "[]")
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []
    return [str(item) for item in data if str(item).strip()]


def _keep(values: list[str] | None, allowed: tuple[str, ...]) -> list[str]:
    if not values:
        return []
    return [item for item in values if item in allowed]


def display_name(row: DigitalEmployee) -> str:
    owner = (row.owner_name or row.owner_user_id or "").strip()
    name = (row.name or "未命名").strip()
    return f"{name} @{owner}" if owner else name


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def _bindings(db: AsyncSession, employee_id: str) -> list[EmployeeResourceBinding]:
    rows = (
        await db.execute(
            select(EmployeeResourceBinding).where(EmployeeResourceBinding.employee_id == employee_id)
        )
    ).scalars().all()
    return list(rows)


def active_bindings(rows: list[EmployeeResourceBinding]) -> list[EmployeeResourceBinding]:
    return [row for row in rows if row.status == "active"]


async def _used(db: AsyncSession, employee_id: str, user_id: str) -> bool:
    row = (
        await db.execute(
            select(EmployeeUsage).where(
                EmployeeUsage.employee_id == employee_id,
                EmployeeUsage.user_id == user_id,
            )
        )
    ).scalar_one_or_none()
    return row is not None


async def _project_role(db: AsyncSession, employee_id: str, user_id: str) -> str | None:
    pins = (
        await db.execute(
            select(ProjectEmployee).where(
                ProjectEmployee.employee_id == employee_id,
                ProjectEmployee.enabled == 1,
            )
        )
    ).scalars().all()
    best = 0
    found: str | None = None
    rank = {"viewer": 1, "editor": 2, "owner": 3}
    for pin in pins:
        member = (
            await db.execute(
                select(ProjectMember).where(
                    ProjectMember.project_id == pin.project_id,
                    ProjectMember.user_id == user_id,
                )
            )
        ).scalar_one_or_none()
        if member is None:
            continue
        role = str(member.role or "viewer")
        if rank.get(role, 0) > best:
            best = rank[role]
            found = role
    return found


async def access_flags(
    db: AsyncSession,
    row: DigitalEmployee,
    user_id: str,
    *,
    is_admin: bool,
) -> dict[str, bool]:
    owner = row.owner_user_id == user_id
    published = bool(row.published_to_gallery)
    active = row.status == "active"
    project_role = await _project_role(db, row.id, user_id)
    used = await _used(db, row.id, user_id)
    can_view = bool(is_admin or owner or published or project_role)
    can_manage = bool(is_admin or owner)
    can_use = bool(
        active
        and (
            owner
            or (project_role in {"editor", "owner"})
            or used
        )
    )
    return {
        "can_view": can_view,
        "can_use": can_use,
        "can_manage": can_manage,
        "used_by_current_user": used,
    }


def public_employee(
    row: DigitalEmployee,
    bindings: list[EmployeeResourceBinding],
    flags: dict[str, bool],
) -> dict[str, Any]:
    active = active_bindings(bindings)
    return {
        "id": row.id,
        "name": row.name,
        "display_name": display_name(row),
        "role_name": row.role_name,
        "description": row.description or "",
        "persona_prompt": row.persona_prompt or "",
        "onboarded_at": row.onboarded_at or "",
        "work_styles": _loads(row.work_styles_json),
        "expertise": _loads(row.expertise_json),
        "work_modes": _loads(row.work_modes_json),
        "status": row.status,
        "published_to_gallery": bool(row.published_to_gallery),
        "owner_user_id": row.owner_user_id,
        "owner_name": row.owner_name or "",
        "scenario_id": row.scenario_id or "",
        "scenario_version": row.scenario_version or "",
        "pack_id": row.pack_id or "",
        "binding_count": len(active),
        "bindings": [
            {
                "id": item.id,
                "resource_type": item.resource_type,
                "resource_id": item.resource_id,
                "resource_version": item.resource_version or "",
                "status": item.status,
                "internal": bool(item.internal),
            }
            for item in active
        ],
        "discoverable_skills": [
            item.resource_id
            for item in active
            if item.resource_type == "skill" and not item.internal
        ],
        **flags,
    }


async def get_employee(db: AsyncSession, employee_id: str) -> DigitalEmployee:
    row = await db.get(DigitalEmployee, employee_id)
    if row is None:
        raise EmployeeAccessError("数字员工不存在", 404)
    return row


async def require_view(db: AsyncSession, row: DigitalEmployee, user_id: str, *, is_admin: bool) -> dict[str, bool]:
    flags = await access_flags(db, row, user_id, is_admin=is_admin)
    if not flags["can_view"]:
        raise EmployeeAccessError("无权查看该数字员工")
    return flags


async def require_manage(db: AsyncSession, row: DigitalEmployee, user_id: str, *, is_admin: bool) -> None:
    flags = await access_flags(db, row, user_id, is_admin=is_admin)
    if not flags["can_manage"]:
        raise EmployeeAccessError("无权管理该数字员工")


async def require_use(db: AsyncSession, row: DigitalEmployee, user_id: str, *, is_admin: bool) -> None:
    flags = await access_flags(db, row, user_id, is_admin=is_admin)
    if not flags["can_use"]:
        raise EmployeeAccessError("当前不能运行该数字员工")


async def list_employees(
    db: AsyncSession,
    user_id: str,
    *,
    is_admin: bool,
    scope: str,
) -> list[dict[str, Any]]:
    rows = (await db.execute(select(DigitalEmployee).order_by(DigitalEmployee.created_at.desc()))).scalars().all()
    out: list[dict[str, Any]] = []
    for row in rows:
        flags = await access_flags(db, row, user_id, is_admin=is_admin)
        if scope == "gallery":
            if not row.published_to_gallery or row.status != "active":
                continue
            if not flags["can_view"]:
                continue
        elif scope == "selectable":
            if not flags["can_use"]:
                continue
        else:
            if not flags["can_view"]:
                continue
        bindings = await _bindings(db, row.id)
        out.append(public_employee(row, bindings, flags))
    return out


async def _name_taken(db: AsyncSession, name: str, exclude_id: str = "") -> bool:
    stmt = select(DigitalEmployee).where(DigitalEmployee.name == name)
    if exclude_id:
        stmt = stmt.where(DigitalEmployee.id != exclude_id)
    return (await db.execute(stmt)).scalar_one_or_none() is not None


def _fill_profile(row: DigitalEmployee, body: dict[str, Any]) -> None:
    if "name" in body and str(body["name"]).strip():
        row.name = str(body["name"]).strip()
    if "role_name" in body:
        row.role_name = str(body.get("role_name") or "待补充").strip() or "待补充"
    if "description" in body:
        row.description = str(body.get("description") or "")
    if "persona_prompt" in body:
        row.persona_prompt = str(body.get("persona_prompt") or "")
    if "onboarded_at" in body:
        row.onboarded_at = str(body.get("onboarded_at") or "")
    if "work_styles" in body:
        row.work_styles_json = json.dumps(_keep(body.get("work_styles"), WORK_STYLES), ensure_ascii=False)
    if "expertise" in body:
        row.expertise_json = json.dumps(_keep(body.get("expertise"), EXPERTISE), ensure_ascii=False)
    if "work_modes" in body:
        row.work_modes_json = json.dumps(_keep(body.get("work_modes"), WORK_MODES), ensure_ascii=False)
    if "scenario_id" in body:
        row.scenario_id = str(body.get("scenario_id") or "")
    if "scenario_version" in body:
        row.scenario_version = str(body.get("scenario_version") or "")
    if "pack_id" in body:
        row.pack_id = str(body.get("pack_id") or "")
    if "published_to_gallery" in body:
        row.published_to_gallery = 1 if body.get("published_to_gallery") else 0
    row.updated_at = _now()


async def create_employee(
    db: AsyncSession,
    *,
    user_id: str,
    owner_name: str,
    body: dict[str, Any],
    is_admin: bool,
) -> dict[str, Any]:
    source_mode = str(body.get("source_mode") or "blank")
    source_id = str(body.get("copy_from_id") or "")
    name = str(body.get("name") or "").strip()
    if not name:
        raise EmployeeAccessError("姓名不能为空", 400)
    if await _name_taken(db, name):
        raise EmployeeAccessError("已存在同名数字员工，请换一个名称", 409)
    row = DigitalEmployee(
        name=name,
        role_name="待补充",
        owner_user_id=user_id,
        owner_name=owner_name or user_id,
        onboarded_at=str(body.get("onboarded_at") or datetime.now().date().isoformat()),
        status="active",
        published_to_gallery=0,
    )
    if source_mode == "copy":
        if not source_id:
            raise EmployeeAccessError("复制上岗需要来源员工", 400)
        source = await get_employee(db, source_id)
        await require_view(db, source, user_id, is_admin=is_admin)
        row.role_name = source.role_name
        row.description = source.description
        row.persona_prompt = source.persona_prompt
        row.work_styles_json = source.work_styles_json
        row.expertise_json = source.expertise_json
        row.work_modes_json = source.work_modes_json
        row.scenario_id = source.scenario_id
        row.scenario_version = source.scenario_version
        row.pack_id = source.pack_id
    _fill_profile(row, {k: v for k, v in body.items() if k != "name"})
    row.name = name
    row.owner_user_id = user_id
    row.published_to_gallery = 0
    db.add(row)
    await db.flush()
    if source_mode == "copy" and source_id:
        for item in active_bindings(await _bindings(db, source_id)):
            db.add(
                EmployeeResourceBinding(
                    employee_id=row.id,
                    resource_type=item.resource_type,
                    resource_id=item.resource_id,
                    resource_version=item.resource_version,
                    status="active",
                    internal=item.internal,
                )
            )
    await db.commit()
    await db.refresh(row)
    logger.info("employee created id=%s owner=%s mode=%s", row.id, user_id, source_mode)
    flags = await access_flags(db, row, user_id, is_admin=is_admin)
    return public_employee(row, await _bindings(db, row.id), flags)


async def update_employee(
    db: AsyncSession,
    employee_id: str,
    user_id: str,
    *,
    is_admin: bool,
    body: dict[str, Any],
) -> dict[str, Any]:
    row = await get_employee(db, employee_id)
    await require_manage(db, row, user_id, is_admin=is_admin)
    if "name" in body:
        name = str(body.get("name") or "").strip()
        if not name:
            raise EmployeeAccessError("姓名不能为空", 400)
        if await _name_taken(db, name, exclude_id=row.id):
            raise EmployeeAccessError("已存在同名数字员工，请换一个名称", 409)
    _fill_profile(row, body)
    await db.commit()
    await db.refresh(row)
    flags = await access_flags(db, row, user_id, is_admin=is_admin)
    return public_employee(row, await _bindings(db, row.id), flags)


async def archive_employee(db: AsyncSession, employee_id: str, user_id: str, *, is_admin: bool) -> dict[str, Any]:
    row = await get_employee(db, employee_id)
    await require_manage(db, row, user_id, is_admin=is_admin)
    row.status = "archived"
    row.updated_at = _now()
    await db.commit()
    flags = await access_flags(db, row, user_id, is_admin=is_admin)
    return public_employee(row, await _bindings(db, row.id), flags)


async def unpublish_employee(
    db: AsyncSession,
    employee_id: str,
    user_id: str,
    *,
    is_admin: bool,
    actor_name: str,
) -> dict[str, Any]:
    row = await get_employee(db, employee_id)
    await require_manage(db, row, user_id, is_admin=is_admin)
    row.published_to_gallery = 0
    row.unpublished_at = _now()
    row.unpublished_by = actor_name or user_id
    row.updated_at = row.unpublished_at
    await db.commit()
    flags = await access_flags(db, row, user_id, is_admin=is_admin)
    return public_employee(row, await _bindings(db, row.id), flags)


async def delete_employee(db: AsyncSession, employee_id: str, user_id: str, *, is_admin: bool) -> dict[str, Any]:
    row = await get_employee(db, employee_id)
    await require_manage(db, row, user_id, is_admin=is_admin)
    run_count = (
        await db.execute(
            select(func.count()).select_from(OrchestrationRun).where(OrchestrationRun.employee_id == row.id)
        )
    ).scalar_one()
    if int(run_count or 0) > 0:
        row.status = "archived"
        row.updated_at = _now()
        await db.commit()
        logger.info("employee archived instead of delete id=%s runs=%s", row.id, run_count)
        return {"deleted": False, "archived": True, "id": row.id}
    for item in await _bindings(db, row.id):
        await db.delete(item)
    await db.delete(row)
    await db.commit()
    logger.info("employee deleted id=%s", employee_id)
    return {"deleted": True, "archived": False, "id": employee_id}


async def replace_bindings(
    db: AsyncSession,
    employee_id: str,
    user_id: str,
    *,
    is_admin: bool,
    items: list[dict[str, Any]],
) -> dict[str, Any]:
    row = await get_employee(db, employee_id)
    await require_manage(db, row, user_id, is_admin=is_admin)
    existing = await _bindings(db, row.id)
    by_key = {(item.resource_type, item.resource_id): item for item in existing}
    for item in existing:
        item.status = "deleted"
        item.updated_at = _now()
    seen: set[tuple[str, str]] = set()
    for raw in items:
        resource_type = str(raw.get("resource_type") or "")
        resource_id = str(raw.get("resource_id") or "").strip()
        if resource_type not in RESOURCE_TYPES or not resource_id:
            continue
        key = (resource_type, resource_id)
        if key in seen:
            continue
        seen.add(key)
        current = by_key.get(key)
        if current is None:
            db.add(
                EmployeeResourceBinding(
                    employee_id=row.id,
                    resource_type=resource_type,
                    resource_id=resource_id,
                    resource_version=str(raw.get("resource_version") or ""),
                    status="active",
                    internal=1 if raw.get("internal") else 0,
                )
            )
        else:
            current.status = "active"
            current.resource_version = str(raw.get("resource_version") or "")
            current.internal = 1 if raw.get("internal") else 0
            current.updated_at = _now()
        if resource_type == "scenario":
            row.scenario_id = resource_id
            row.scenario_version = str(raw.get("resource_version") or row.scenario_version or "")
        if resource_type == "pack":
            row.pack_id = resource_id
    row.updated_at = _now()
    await db.commit()
    logger.info("employee bindings replaced id=%s count=%s", row.id, len(seen))
    flags = await access_flags(db, row, user_id, is_admin=is_admin)
    return public_employee(row, await _bindings(db, row.id), flags)


async def import_bindings(
    db: AsyncSession,
    employee_id: str,
    user_id: str,
    *,
    is_admin: bool,
    source_employee_id: str,
    resource_ids: list[str],
) -> dict[str, Any]:
    if employee_id == source_employee_id:
        raise EmployeeAccessError("来源和目标不能是同一名员工", 400)
    target = await get_employee(db, employee_id)
    source = await get_employee(db, source_employee_id)
    await require_manage(db, target, user_id, is_admin=is_admin)
    await require_view(db, source, user_id, is_admin=is_admin)
    wanted = {item.strip() for item in resource_ids if item and item.strip()}
    have = {(item.resource_type, item.resource_id) for item in active_bindings(await _bindings(db, target.id))}
    copied = 0
    for item in active_bindings(await _bindings(db, source.id)):
        if wanted and item.resource_id not in wanted and item.id not in wanted:
            continue
        key = (item.resource_type, item.resource_id)
        if key in have:
            continue
        db.add(
            EmployeeResourceBinding(
                employee_id=target.id,
                resource_type=item.resource_type,
                resource_id=item.resource_id,
                resource_version=item.resource_version,
                status="active",
                internal=item.internal,
            )
        )
        have.add(key)
        copied += 1
    await db.commit()
    flags = await access_flags(db, target, user_id, is_admin=is_admin)
    payload = public_employee(target, await _bindings(db, target.id), flags)
    payload["imported"] = copied
    return payload


async def pin_to_project(
    db: AsyncSession,
    *,
    project_id: str,
    employee_id: str,
    user_id: str,
    is_admin: bool,
) -> dict[str, Any]:
    row = await get_employee(db, employee_id)
    await require_view(db, row, user_id, is_admin=is_admin)
    existing = (
        await db.execute(
            select(ProjectEmployee).where(
                ProjectEmployee.project_id == project_id,
                ProjectEmployee.employee_id == employee_id,
            )
        )
    ).scalar_one_or_none()
    if existing is None:
        db.add(ProjectEmployee(project_id=project_id, employee_id=employee_id, enabled=1))
    else:
        existing.enabled = 1
    await db.commit()
    logger.info("employee pinned project=%s employee=%s", project_id, employee_id)
    return {"project_id": project_id, "employee_id": employee_id, "enabled": True}


async def mark_employee_used(db: AsyncSession, employee_id: str, user_id: str) -> None:
    if not employee_id or not user_id:
        return
    existing = (
        await db.execute(
            select(EmployeeUsage).where(
                EmployeeUsage.employee_id == employee_id,
                EmployeeUsage.user_id == user_id,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        return
    db.add(EmployeeUsage(employee_id=employee_id, user_id=user_id))
    await db.commit()
    logger.info("employee used employee=%s user=%s", employee_id, user_id)


async def freeze_for_run(
    db: AsyncSession,
    employee_id: str,
    user_id: str,
    *,
    is_admin: bool,
) -> dict[str, Any]:
    row = await get_employee(db, employee_id)
    await require_use(db, row, user_id, is_admin=is_admin)
    bindings = active_bindings(await _bindings(db, row.id))
    skills = [
        {"name": item.resource_id, "version": item.resource_version or "", "internal": bool(item.internal)}
        for item in bindings
        if item.resource_type == "skill"
    ]
    knowledge = [
        {"id": item.resource_id, "version": item.resource_version or ""}
        for item in bindings
        if item.resource_type == "knowledge"
    ]
    templates = [
        {"id": item.resource_id, "version": item.resource_version or ""}
        for item in bindings
        if item.resource_type == "template"
    ]
    return {
        "employee_id": row.id,
        "employee_name": display_name(row),
        "scenario_id": row.scenario_id or "",
        "scenario_version": row.scenario_version or "",
        "pack_id": row.pack_id or "",
        "skills": skills,
        "knowledge": knowledge,
        "templates": templates,
        "work_modes": _loads(row.work_modes_json),
    }


def apply_freeze_to_contract(freeze: dict[str, Any], skills: Any, knowledge: Any, output: Any) -> tuple[Any, Any, Any]:
    """把员工钉住的版本覆盖到本次合同。请求级 overrides 应在此之后再应用。"""
    skill_names = [item["name"] for item in freeze.get("skills") or [] if item.get("name")]
    if skill_names:
        skills = skills.model_copy(
            update={"allowed": skill_names, "mode": "allowed_list", "allow_agent_free_choice": False}
        )
    collections = [item["id"] for item in freeze.get("knowledge") or [] if item.get("id")]
    if collections:
        knowledge = knowledge.model_copy(update={"collections": collections, "mode": "restricted"})
    templates = freeze.get("templates") or []
    if templates and not getattr(output, "template_id", None):
        output = output.model_copy(update={"template_id": templates[0]["id"]})
    return skills, knowledge, output


def model_facing_excerpts(items: list[dict[str, Any]]) -> list[dict[str, str]]:
    excerpts: list[dict[str, str]] = []
    for item in items:
        text = str(item.get("content") or item.get("text") or item.get("excerpt") or "").strip()
        if not text:
            continue
        excerpts.append(
            {
                "label": f"[{len(excerpts) + 1}]",
                "title": str(item.get("title") or ""),
                "source": str(item.get("source") or item.get("document_id") or ""),
                "version": str(item.get("version") or ""),
                "excerpt": text[:EXCERPT_CHARS],
            }
        )
        if len(excerpts) >= EXCERPT_LIMIT:
            break
    return excerpts


def knowledge_query(
    freeze: dict[str, Any],
    *,
    purpose: str,
    hits: list[dict[str, Any]],
    plan: dict[str, Any] | None,
    preview_failed: bool,
) -> dict[str, Any]:
    allowed = {item["id"] for item in freeze.get("knowledge") or []}
    versions = {item["id"]: item.get("version") or "" for item in freeze.get("knowledge") or []}
    if preview_failed:
        return {
            "purpose": purpose,
            "applied": False,
            "plan": plan or {},
            "excerpts": [],
            "scope": list(allowed),
        }
    scoped: list[dict[str, Any]] = []
    for hit in hits:
        collection = str(hit.get("collection") or hit.get("id") or "")
        if allowed and collection and collection not in allowed and str(hit.get("knowledge_id") or "") not in allowed:
            continue
        version = versions.get(collection) or versions.get(str(hit.get("knowledge_id") or "")) or hit.get("version") or ""
        scoped.append({**hit, "version": version})
    if not allowed:
        scoped = list(hits)
    return {
        "purpose": purpose,
        "applied": True,
        "plan": plan or {},
        "scope": sorted(allowed),
        "versions": versions,
        "excerpts": model_facing_excerpts(scoped),
    }


async def issue_credential(
    db: AsyncSession,
    *,
    kind: str,
    owner_user_id: str,
    employee_id: str = "",
    is_admin: bool = False,
) -> dict[str, Any]:
    if kind not in {"account", "employee"}:
        raise EmployeeAccessError("钥匙类型无效", 400)
    if kind == "employee":
        row = await get_employee(db, employee_id)
        await require_manage(db, row, owner_user_id, is_admin=is_admin)
    token = "te_live_" + secrets.token_urlsafe(24)
    digest = _hash_token(token)
    expires = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
    cred = EmployeeCredential(
        kind=kind,
        owner_user_id=owner_user_id,
        employee_id=employee_id if kind == "employee" else "",
        prefix=token[:12],
        token_hash=digest,
        expires_at=expires,
    )
    db.add(cred)
    await db.commit()
    logger.info("employee credential issued kind=%s owner=%s employee=%s", kind, owner_user_id, employee_id)
    return {
        "id": cred.id,
        "kind": kind,
        "employee_id": cred.employee_id or "",
        "prefix": cred.prefix,
        "expires_at": expires,
        "token": token,
    }


async def revoke_credential(db: AsyncSession, credential_id: str, user_id: str, *, is_admin: bool) -> dict[str, str]:
    row = await db.get(EmployeeCredential, credential_id)
    if row is None:
        raise EmployeeAccessError("钥匙不存在", 404)
    if row.owner_user_id != user_id and not is_admin:
        raise EmployeeAccessError("无权轮换该钥匙")
    row.revoked_at = _now()
    await db.commit()
    return {"id": row.id, "revoked_at": row.revoked_at}


async def credential_from_token(db: AsyncSession, token: str) -> EmployeeCredential | None:
    digest = _hash_token(token.strip())
    row = (
        await db.execute(select(EmployeeCredential).where(EmployeeCredential.token_hash == digest))
    ).scalar_one_or_none()
    if row is None or row.revoked_at:
        return None
    try:
        exp = datetime.fromisoformat(row.expires_at)
    except ValueError:
        return None
    if exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)
    if datetime.now(timezone.utc) >= exp:
        return None
    return row


async def assert_credential_can_run(
    db: AsyncSession,
    cred: EmployeeCredential,
    employee_id: str,
) -> None:
    if cred.kind == "employee" and cred.employee_id != employee_id:
        raise EmployeeAccessError("员工钥匙不能运行其他员工")
    row = await get_employee(db, employee_id)
    if cred.kind == "account":
        await require_use(db, row, cred.owner_user_id, is_admin=False)


async def bind_feishu(db: AsyncSession, *, app_id: str, employee_id: str, user_id: str, is_admin: bool) -> dict[str, str]:
    row = await get_employee(db, employee_id)
    await require_manage(db, row, user_id, is_admin=is_admin)
    if row.status != "active":
        raise EmployeeAccessError("只能把渠道挂到在岗员工", 400)
    db.add(FeishuEmployeeBinding(app_id=app_id, employee_id=employee_id, status="active"))
    await db.commit()
    logger.info("feishu bound app=%s employee=%s", app_id, employee_id)
    return {"app_id": app_id, "employee_id": employee_id, "status": "active"}


async def accept_feishu_inbound(
    db: AsyncSession,
    *,
    event_id: str,
    employee_id: str,
    user_id: str,
    message: str,
) -> dict[str, Any]:
    event_id = event_id.strip()
    if not event_id:
        raise EmployeeAccessError("缺少事件编号", 400)
    existing = (
        await db.execute(select(FeishuInboundEvent).where(FeishuInboundEvent.event_id == event_id))
    ).scalar_one_or_none()
    if existing is not None:
        logger.info("feishu inbound duplicate event=%s", event_id)
        return {"duplicate": True, "event_id": event_id, "run_id": existing.run_id or "", "employee_id": existing.employee_id}
    row = await get_employee(db, employee_id)
    if row.status != "active":
        raise EmployeeAccessError("员工不在岗", 400)
    local_user_id = await resolve_feishu_local_user(db, user_id)
    await require_use(db, row, local_user_id, is_admin=False)
    user_id = local_user_id
    running = (
        await db.execute(
            select(OrchestrationRun).where(
                OrchestrationRun.employee_id == employee_id,
                OrchestrationRun.user_id == user_id,
                OrchestrationRun.status == "running",
            )
        )
    ).scalars().first()
    if running is not None:
        db.add(FeishuInboundEvent(event_id=event_id, employee_id=employee_id, user_id=user_id, run_id=running.id))
        await db.commit()
        return {
            "duplicate": False,
            "switched": False,
            "employee_id": employee_id,
            "run_id": running.id,
            "queued": True,
            "message": message,
        }
    run = OrchestrationRun(
        project_id=None,
        scenario_id=row.scenario_id or None,
        employee_id=employee_id,
        entrypoint="chat",
        status="running",
        user_id=user_id or "default",
        request_json=json.dumps({"message": message, "channel": "feishu"}, ensure_ascii=False),
        snapshot_json=json.dumps({"employee_id": employee_id, "channel": "feishu"}, ensure_ascii=False),
    )
    db.add(run)
    await db.flush()
    db.add(FeishuInboundEvent(event_id=event_id, employee_id=employee_id, user_id=user_id, run_id=run.id))
    await db.commit()
    logger.info("feishu inbound accepted event=%s employee=%s run=%s", event_id, employee_id, run.id)
    return {"duplicate": False, "switched": False, "employee_id": employee_id, "run_id": run.id, "queued": False}


async def create_draft_run(
    db: AsyncSession,
    employee_id: str,
    user_id: str,
    *,
    is_admin: bool,
    project_id: str | None,
) -> dict[str, Any]:
    freeze = await freeze_for_run(db, employee_id, user_id, is_admin=is_admin)
    run = OrchestrationRun(
        project_id=project_id or None,
        scenario_id=freeze["scenario_id"] or None,
        employee_id=employee_id,
        entrypoint="chat",
        status="draft",
        user_id=user_id,
        request_json="{}",
        snapshot_json=json.dumps(freeze, ensure_ascii=False),
    )
    db.add(run)
    await db.commit()
    await db.refresh(run)
    return {"run_id": run.id, "status": run.status, "snapshot": freeze}


def build_trace_lines(
    snapshot: dict[str, Any] | None,
    metadata: dict[str, Any] | None,
    status: str,
    assistant_content: str | None,
) -> list[dict[str, str]]:
    """把冻结的员工绑定和回答收成同一轮轨迹。取消后正文仍保留。"""
    snap = snapshot or {}
    nested = snap.get("employee") if isinstance(snap.get("employee"), dict) else None
    employee = nested or snap
    state = "completed" if status == "completed" else ("failed" if status == "failed" else status or "running")
    lines: list[dict[str, str]] = []
    for skill in employee.get("skills") or []:
        if not isinstance(skill, dict):
            continue
        lines.append(
            {
                "kind": "skill",
                "state": state,
                "text": str(skill.get("name") or ""),
                "detail": str(skill.get("version") or ""),
            }
        )
    for item in employee.get("knowledge") or []:
        if not isinstance(item, dict):
            continue
        lines.append(
            {
                "kind": "knowledge",
                "state": state,
                "text": str(item.get("id") or ""),
                "detail": str(item.get("version") or ""),
            }
        )
    meta = metadata or {}
    if meta.get("tool_capture_hit"):
        lines.append({"kind": "tool", "state": "completed", "text": "工具正文已捕获", "detail": ""})
    text = (assistant_content or "").strip()
    if text:
        lines.append({"kind": "answer", "state": "completed" if status != "failed" else "failed", "text": text[:280], "detail": ""})
    return lines


async def link_feishu_user(db: AsyncSession, *, channel_user_id: str, local_user_id: str) -> dict[str, str]:
    channel_user_id = channel_user_id.strip()
    local_user_id = local_user_id.strip()
    if not channel_user_id or not local_user_id:
        raise EmployeeAccessError("缺少飞书身份或本地账号", 400)
    row = (
        await db.execute(select(FeishuUserLink).where(FeishuUserLink.channel_user_id == channel_user_id))
    ).scalar_one_or_none()
    if row is None:
        row = FeishuUserLink(channel_user_id=channel_user_id, local_user_id=local_user_id)
        db.add(row)
    else:
        row.local_user_id = local_user_id
    await db.commit()
    logger.info("feishu identity linked channel=%s local=%s", channel_user_id, local_user_id)
    return {"channel_user_id": channel_user_id, "local_user_id": local_user_id}


async def resolve_feishu_local_user(db: AsyncSession, channel_user_id: str) -> str:
    row = (
        await db.execute(select(FeishuUserLink).where(FeishuUserLink.channel_user_id == channel_user_id))
    ).scalar_one_or_none()
    return row.local_user_id if row is not None else channel_user_id


async def retry_feishu_outbound(db: AsyncSession, event_id: str, *, error: str = "") -> dict[str, Any]:
    row = (
        await db.execute(select(FeishuInboundEvent).where(FeishuInboundEvent.event_id == event_id))
    ).scalar_one_or_none()
    if row is None:
        raise EmployeeAccessError("入站事件不存在", 404)
    attempts = int(row.attempts or 0) + 1
    row.attempts = attempts
    row.last_error = error
    await db.commit()
    logger.info("feishu outbound retry event=%s attempts=%s", event_id, attempts)
    return {"event_id": event_id, "attempts": attempts, "run_id": row.run_id or "", "retry": attempts <= 3}


async def create_confirmation(
    db: AsyncSession,
    *,
    subject_type: str,
    subject_id: str,
    employee_id: str,
    plan: dict[str, Any],
) -> dict[str, Any]:
    if subject_type not in {"govern", "co_create"}:
        raise EmployeeAccessError("确认类型无效", 400)
    row = ConfirmationStep(
        subject_type=subject_type,
        subject_id=subject_id,
        employee_id=employee_id,
        status="pending",
        plan_json=json.dumps(plan, ensure_ascii=False),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return {"id": row.id, "status": row.status, "plan": plan}


async def act_on_confirmation(
    db: AsyncSession,
    step_id: str,
    *,
    action: str,
    note: str,
    actor_user_id: str,
) -> dict[str, Any]:
    row = await db.get(ConfirmationStep, step_id)
    if row is None:
        raise EmployeeAccessError("确认步骤不存在", 404)
    plan = json.loads(row.plan_json or "{}")
    if row.status != "pending":
        return {"id": row.id, "status": row.status, "plan": plan, "changed": False}
    if action not in {"confirm", "reject", "handoff"}:
        raise EmployeeAccessError("当前状态不能执行该动作", 400)
    row.status = {"confirm": "confirmed", "reject": "rejected", "handoff": "handed_off"}[action]
    row.note = note
    row.actor_user_id = actor_user_id
    row.updated_at = _now()
    await db.commit()
    logger.info("confirmation %s id=%s actor=%s", row.status, row.id, actor_user_id)
    return {"id": row.id, "status": row.status, "plan": plan, "changed": True}


async def employee_knowledge_ids(db: AsyncSession, employee_id: str) -> set[str]:
    rows = active_bindings(await _bindings(db, employee_id))
    return {item.resource_id for item in rows if item.resource_type == "knowledge"}


async def cancel_run(db: AsyncSession, run_id: str, user_id: str) -> dict[str, str]:
    row = await db.get(OrchestrationRun, run_id)
    if row is None:
        raise EmployeeAccessError("运行不存在", 404)
    if user_id != "default" and row.user_id and row.user_id != user_id:
        raise EmployeeAccessError("无权取消该运行")
    if row.status == "running":
        row.status = "cancelled"
        row.updated_at = _now()
        await db.commit()
    return {"run_id": row.id, "status": row.status or ""}
