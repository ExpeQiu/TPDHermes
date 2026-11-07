"""数字员工花名册、档案、绑定、检索与钥匙。"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import get_db
from backend.services.digital_employee_service import (
    EmployeeAccessError,
    accept_feishu_inbound,
    archive_employee,
    assert_credential_can_run,
    bind_feishu,
    cancel_run,
    create_draft_run,
    create_employee,
    credential_from_token,
    delete_employee,
    freeze_for_run,
    get_employee,
    import_bindings,
    issue_credential,
    knowledge_query,
    list_employees,
    pin_to_project,
    replace_bindings,
    require_manage,
    require_use,
    require_view,
    revoke_credential,
    unpublish_employee,
    update_employee,
    _bindings,
    access_flags,
    public_employee,
)
from backend.services.rbac import resolve_platform_role
from backend.services.user_identity import get_effective_user_id, is_global_admin_user

logger = logging.getLogger("tpdx.hermes.employees")

router = APIRouter(prefix="/employees", tags=["employees"])


class EmployeeWrite(BaseModel):
    name: str | None = None
    role_name: str | None = None
    description: str | None = None
    persona_prompt: str | None = None
    onboarded_at: str | None = None
    work_styles: list[str] | None = None
    expertise: list[str] | None = None
    work_modes: list[str] | None = None
    scenario_id: str | None = None
    scenario_version: str | None = None
    pack_id: str | None = None
    published_to_gallery: bool | None = None
    source_mode: str | None = None
    copy_from_id: str | None = None


class BindingIn(BaseModel):
    resource_type: str
    resource_id: str
    resource_version: str = ""
    internal: bool = False


class BindingsBody(BaseModel):
    items: list[BindingIn] = Field(default_factory=list)


class ImportBody(BaseModel):
    source_employee_id: str
    resource_ids: list[str] = Field(default_factory=list)


class PinBody(BaseModel):
    project_id: str
    employee_id: str


class KnowledgeQueryBody(BaseModel):
    purpose: str = "answer"
    hits: list[dict[str, Any]] = Field(default_factory=list)
    plan: dict[str, Any] | None = None
    preview_failed: bool = False


class CredentialBody(BaseModel):
    kind: str = "account"


class FeishuBindBody(BaseModel):
    app_id: str = ""
    employee_id: str


class FeishuInboundBody(BaseModel):
    event_id: str
    employee_id: str
    user_id: str = ""
    message: str = ""


class DraftBody(BaseModel):
    project_id: str | None = None


class ConfirmationCreate(BaseModel):
    subject_type: str
    subject_id: str = ""
    employee_id: str = ""
    plan: dict[str, Any] = Field(default_factory=dict)


class ConfirmationAct(BaseModel):
    action: str
    note: str = ""


def _raise(exc: EmployeeAccessError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


async def _actor(request: Request, db: AsyncSession) -> tuple[str, bool, str]:
    user_id = get_effective_user_id(request)
    role = await resolve_platform_role(db, request, user_id)
    is_admin = role in {"platform_admin", "tenant_admin"} or is_global_admin_user(user_id)
    name = request.headers.get("x-user-name") or user_id
    return user_id, is_admin, name


@router.get("")
async def api_list(
    request: Request,
    scope: str = Query("roster"),
    db: AsyncSession = Depends(get_db),
):
    user_id, is_admin, _name = await _actor(request, db)
    if scope not in {"roster", "gallery", "selectable"}:
        raise HTTPException(status_code=400, detail="scope 无效")
    rows = await list_employees(db, user_id, is_admin=is_admin, scope=scope)
    logger.info("employees listed user=%s scope=%s count=%s", user_id, scope, len(rows))
    return {"items": rows}


@router.post("")
async def api_create(body: EmployeeWrite, request: Request, db: AsyncSession = Depends(get_db)):
    user_id, is_admin, name = await _actor(request, db)
    try:
        return await create_employee(
            db,
            user_id=user_id,
            owner_name=name,
            body=body.model_dump(exclude_none=True),
            is_admin=is_admin,
        )
    except EmployeeAccessError as exc:
        _raise(exc)


@router.get("/{employee_id}")
async def api_get(employee_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    user_id, is_admin, _name = await _actor(request, db)
    try:
        row = await get_employee(db, employee_id)
        flags = await require_view(db, row, user_id, is_admin=is_admin)
        return public_employee(row, await _bindings(db, row.id), flags)
    except EmployeeAccessError as exc:
        _raise(exc)


@router.api_route("/{employee_id}", methods=["PATCH", "PUT"])
async def api_patch(employee_id: str, body: EmployeeWrite, request: Request, db: AsyncSession = Depends(get_db)):
    user_id, is_admin, _name = await _actor(request, db)
    try:
        return await update_employee(
            db,
            employee_id,
            user_id,
            is_admin=is_admin,
            body=body.model_dump(exclude_none=True),
        )
    except EmployeeAccessError as exc:
        _raise(exc)


@router.post("/{employee_id}/archive")
async def api_archive(employee_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    user_id, is_admin, _name = await _actor(request, db)
    try:
        return await archive_employee(db, employee_id, user_id, is_admin=is_admin)
    except EmployeeAccessError as exc:
        _raise(exc)


@router.post("/{employee_id}/unpublish")
async def api_unpublish(employee_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    user_id, is_admin, name = await _actor(request, db)
    try:
        return await unpublish_employee(db, employee_id, user_id, is_admin=is_admin, actor_name=name)
    except EmployeeAccessError as exc:
        _raise(exc)


@router.delete("/{employee_id}")
async def api_delete(employee_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    user_id, is_admin, _name = await _actor(request, db)
    try:
        return await delete_employee(db, employee_id, user_id, is_admin=is_admin)
    except EmployeeAccessError as exc:
        _raise(exc)


@router.put("/{employee_id}/bindings")
async def api_bindings(
    employee_id: str,
    body: BindingsBody,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    user_id, is_admin, _name = await _actor(request, db)
    try:
        return await replace_bindings(
            db,
            employee_id,
            user_id,
            is_admin=is_admin,
            items=[item.model_dump() for item in body.items],
        )
    except EmployeeAccessError as exc:
        _raise(exc)


@router.post("/{employee_id}/bindings/import")
async def api_import(
    employee_id: str,
    body: ImportBody,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    user_id, is_admin, _name = await _actor(request, db)
    try:
        return await import_bindings(
            db,
            employee_id,
            user_id,
            is_admin=is_admin,
            source_employee_id=body.source_employee_id,
            resource_ids=body.resource_ids,
        )
    except EmployeeAccessError as exc:
        _raise(exc)


@router.post("/project-pins")
async def api_pin(body: PinBody, request: Request, db: AsyncSession = Depends(get_db)):
    user_id, is_admin, _name = await _actor(request, db)
    try:
        return await pin_to_project(
            db,
            project_id=body.project_id,
            employee_id=body.employee_id,
            user_id=user_id,
            is_admin=is_admin,
        )
    except EmployeeAccessError as exc:
        _raise(exc)


@router.post("/{employee_id}/draft-runs")
async def api_draft(
    employee_id: str,
    body: DraftBody,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    user_id, is_admin, _name = await _actor(request, db)
    try:
        return await create_draft_run(
            db,
            employee_id,
            user_id,
            is_admin=is_admin,
            project_id=body.project_id,
        )
    except EmployeeAccessError as exc:
        _raise(exc)


@router.post("/runs/{run_id}/cancel")
async def api_cancel(run_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    user_id, _is_admin, _name = await _actor(request, db)
    try:
        return await cancel_run(db, run_id, user_id)
    except EmployeeAccessError as exc:
        _raise(exc)


@router.post("/{employee_id}/knowledge/query")
async def api_knowledge(
    employee_id: str,
    body: KnowledgeQueryBody,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    user_id, is_admin, _name = await _actor(request, db)
    try:
        row = await get_employee(db, employee_id)
        await require_use(db, row, user_id, is_admin=is_admin)
        freeze = await freeze_for_run(db, employee_id, user_id, is_admin=is_admin)
    except EmployeeAccessError as exc:
        _raise(exc)
    return knowledge_query(
        freeze,
        purpose=body.purpose,
        hits=body.hits,
        plan=body.plan,
        preview_failed=body.preview_failed,
    )


@router.post("/credentials")
async def api_account_key(body: CredentialBody, request: Request, db: AsyncSession = Depends(get_db)):
    user_id, is_admin, _name = await _actor(request, db)
    try:
        return await issue_credential(db, kind=body.kind or "account", owner_user_id=user_id, is_admin=is_admin)
    except EmployeeAccessError as exc:
        _raise(exc)


@router.post("/{employee_id}/credentials")
async def api_employee_key(employee_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    user_id, is_admin, _name = await _actor(request, db)
    try:
        return await issue_credential(
            db,
            kind="employee",
            owner_user_id=user_id,
            employee_id=employee_id,
            is_admin=is_admin,
        )
    except EmployeeAccessError as exc:
        _raise(exc)


@router.delete("/credentials/{credential_id}")
async def api_revoke(credential_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    user_id, is_admin, _name = await _actor(request, db)
    try:
        return await revoke_credential(db, credential_id, user_id, is_admin=is_admin)
    except EmployeeAccessError as exc:
        _raise(exc)


@router.get("/credentials/whoami")
async def api_whoami(
    employee_id: str = Query(...),
    authorization: str = Header(default=""),
    db: AsyncSession = Depends(get_db),
):
    token = authorization.removeprefix("Bearer ").strip()
    cred = await credential_from_token(db, token)
    if cred is None:
        raise HTTPException(status_code=401, detail="钥匙无效")
    try:
        await assert_credential_can_run(db, cred, employee_id)
    except EmployeeAccessError as exc:
        _raise(exc)
    return {"ok": True, "kind": cred.kind, "employee_id": employee_id, "owner_user_id": cred.owner_user_id}


@router.post("/channels/feishu")
async def api_feishu_bind(body: FeishuBindBody, request: Request, db: AsyncSession = Depends(get_db)):
    user_id, is_admin, _name = await _actor(request, db)
    try:
        return await bind_feishu(
            db,
            app_id=body.app_id,
            employee_id=body.employee_id,
            user_id=user_id,
            is_admin=is_admin,
        )
    except EmployeeAccessError as exc:
        _raise(exc)


@router.post("/channels/feishu/inbound")
async def api_feishu_inbound(body: FeishuInboundBody, db: AsyncSession = Depends(get_db)):
    try:
        return await accept_feishu_inbound(
            db,
            event_id=body.event_id,
            employee_id=body.employee_id,
            user_id=body.user_id,
            message=body.message,
        )
    except EmployeeAccessError as exc:
        _raise(exc)


@router.post("/confirmations")
async def api_confirmation_create(body: ConfirmationCreate, db: AsyncSession = Depends(get_db)):
    from backend.services.digital_employee_service import create_confirmation

    try:
        return await create_confirmation(
            db,
            subject_type=body.subject_type,
            subject_id=body.subject_id,
            employee_id=body.employee_id,
            plan=body.plan,
        )
    except EmployeeAccessError as exc:
        _raise(exc)


@router.post("/confirmations/{step_id}/act")
async def api_confirmation_act(
    step_id: str,
    body: ConfirmationAct,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    from backend.services.digital_employee_service import act_on_confirmation

    user_id, _is_admin, _name = await _actor(request, db)
    try:
        return await act_on_confirmation(
            db,
            step_id,
            action=body.action,
            note=body.note,
            actor_user_id=user_id,
        )
    except EmployeeAccessError as exc:
        _raise(exc)


async def read_employee_card(db: AsyncSession, employee_id: str, user_id: str, is_admin: bool) -> dict[str, Any]:
    """供档案页以外的调用复用权限计算。"""
    row = await get_employee(db, employee_id)
    flags = await access_flags(db, row, user_id, is_admin=is_admin)
    await require_manage(db, row, user_id, is_admin=is_admin)
    return public_employee(row, await _bindings(db, row.id), flags)
