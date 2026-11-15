"""技术卡工作区：对话回合交给 Hermes 选择动作。"""

from __future__ import annotations

import logging
import re
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import get_db
from backend.services.tech_card_studio import (
    apply_operation,
    create_state,
    normalize_state,
    parse_command,
)
from backend.services.tpcstore_bridge import (
    call_tpcstore,
    read_studio_source,
    read_workbench_html,
)
from backend.services.user_identity import get_effective_user_id

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/studio", tags=["studio"])


class StudioTurnRequest(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    state: dict[str, Any] | None = None
    project_id: str | None = None
    file_id: str | None = None
    file_kind: Literal["output", "attachment"] | None = None
    demo: bool = False


@router.get("/config")
async def studio_config() -> dict[str, Any]:
    try:
        capabilities = await call_tpcstore("capabilities")
        return {
            "product": "V04",
            "driver": "tpcstore",
            "connected": True,
            **capabilities,
        }
    except HTTPException as exc:
        return {
            "product": "V04",
            "driver": "tpcstore",
            "connected": False,
            "configured": False,
            "reason": exc.detail,
        }


@router.post("/turn")
async def studio_turn(
    request: StudioTurnRequest,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_effective_user_id),
) -> dict[str, Any]:
    operation = parse_command(request.message)
    if request.demo:
        if request.project_id or request.file_id or request.file_kind:
            raise HTTPException(422, "样本演示不能混用真实项目资料")
        result = apply_operation(
            normalize_state(request.state) if request.state else create_state(),
            operation,
            request.message,
        )
        return {
            **result,
            "driver": "mock",
            "fallback_reason": None,
            "persistence": "session_preview",
            "release_authorized": False,
        }
    if not request.project_id or not request.file_id or not request.file_kind:
        raise HTTPException(422, "请选择项目和资料；样本演示需显式开启")
    source = await read_studio_source(
        db, request.project_id, request.file_id, request.file_kind, user_id
    )
    if operation not in {"extract", "gaps", "lock"}:
        raise HTTPException(
            422, "首轮 TPCstore 通路支持提取技术卡、查看缺口、锁定当前卡"
        )
    result = await call_tpcstore(
        "turn",
        {
            "schema_version": "1.0.0",
            "operation": operation,
            "source": source,
            "state": request.state,
            "expected_revision": (request.state or {}).get("revision", 0),
        },
    )
    logger.info(
        "studio tpcstore project_id=%s file_id=%s file_kind=%s",
        request.project_id or "",
        request.file_id or "",
        request.file_kind or "",
    )
    return result


class WorkbenchRequest(BaseModel):
    operation: Literal[
        "show", "extract", "save", "check", "export", "task-show", "reconcile"
    ]
    project_id: str
    file_id: str
    file_kind: Literal["output", "attachment"]
    expected_revision: int | None = None
    source_sha256: str | None = None
    idempotency_key: str | None = None
    task_id: str | None = None
    card_id: str | None = None
    fields: dict[str, Any] | None = None


@router.get("/workbench/page", response_class=PlainTextResponse)
async def workbench_page() -> str:
    return read_workbench_html()


@router.post("/workbench")
async def workbench_operation(
    request: WorkbenchRequest,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_effective_user_id),
) -> dict[str, Any]:
    source = await read_studio_source(
        db, request.project_id, request.file_id, request.file_kind, user_id
    )
    from backend.services.project_session_service import attach_scene_scope

    scoped = await attach_scene_scope(
        db,
        project_id=request.project_id,
        product="V04",
        user_id=user_id,
        payload={
            "source": source,
            **request.model_dump(
                exclude={"project_id", "file_id", "file_kind"}, exclude_none=True
            ),
        },
    )
    return await call_tpcstore("workspace", scoped)


class WorkbenchChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    project_id: str
    file_id: str
    file_kind: Literal["output", "attachment"]


@router.post("/workbench/chat")
async def workbench_chat(
    request: WorkbenchChatRequest,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_effective_user_id),
) -> dict[str, Any]:
    source = await read_studio_source(
        db, request.project_id, request.file_id, request.file_kind, user_id
    )
    return await execute_workbench_chat(request.message, source)


async def _scope_v04_workspace(payload: dict[str, Any]) -> dict[str, Any]:
    project_id = str((payload.get("source") or {}).get("project_id") or "").strip()
    if not project_id:
        return payload
    from backend.db import async_session_maker
    from backend.services.project_session_service import attach_scene_scope

    async with async_session_maker() as db:
        return await attach_scene_scope(
            db,
            project_id=project_id,
            product="V04",
            user_id="studio",
            payload=payload,
        )


async def execute_workbench_chat(
    message: str, source: dict[str, str], request_id: str | None = None
) -> dict[str, Any]:
    from backend.services.studio_agent import choose_studio_action

    decision = await choose_studio_action(message)
    if decision.action == "unsupported":
        return {
            "action": decision.action,
            "reply": "对话支持提取候选、查看工作区和列出缺口。字段修订及核对确认请在工作台操作。",
        }
    workspace = await call_tpcstore(
        "workspace", await _scope_v04_workspace({"source": source, "operation": "show"})
    )
    if workspace.get("source_conflict"):
        raise HTTPException(409, "原文已变化，请在工作台对照当前资料与历史版本")
    if decision.action == "save":
        number, field = decision.card_number, decision.field
        start, end = decision.line_start, decision.line_end
        lines = source["text"].split("\n")
        if (
            not number
            or not field
            or not start
            or not end
            or not (number <= len(workspace["cards"]) and start <= end <= len(lines))
        ):
            raise HTTPException(422, "请指定有效的卡片序号、字段和原文行号")
        card = workspace["cards"][number - 1]
        if card.get("checked_at") or card.get("status") in {"rejected", "stale"}:
            raise HTTPException(409, "请选择可修订的候选卡")
        quote = "\n".join(lines[start - 1 : end])
        if not quote.strip():
            raise HTTPException(422, "所选原文行为空")
        fields = {
            name: {**card["sources"][name], "value": card[name]}
            if card.get(name)
            else None
            for name in ("definition", "principle", "parameter", "scope")
        }
        fields[field] = {
            "source_id": source["id"],
            "line_start": start,
            "line_end": end,
            "quote": quote,
            "value": quote,
        }
        workspace = await call_tpcstore(
            "workspace",
            await _scope_v04_workspace(
                {
                    "source": source,
                    "operation": "save",
                    "expected_revision": workspace["revision"],
                    "source_sha256": source["sha256"],
                    "card_id": card["id"],
                    "fields": fields,
                    **({"idempotency_key": request_id} if request_id else {}),
                }
            ),
        )
    if decision.action == "extract":
        workspace = await call_tpcstore(
            "workspace",
            await _scope_v04_workspace(
                {
                    "source": source,
                    "operation": "extract",
                    "expected_revision": workspace["revision"],
                    **({"idempotency_key": request_id} if request_id else {}),
                }
            ),
            needs_model=True,
        )
        task = next(
            (
                item
                for item in reversed(workspace.get("tasks", []))
                if not request_id or item.get("idempotency_key") == request_id
            ),
            None,
        )
        if task and task.get("status") == "unknown":
            return {
                "action": "extract",
                "reply": "上游提取结果暂不可确认。请查看任务回执。",
                "revision": workspace["revision"],
                "task_id": task["id"],
                "result_unknown": True,
            }
    if workspace.get("source_conflict"):
        raise HTTPException(409, "原文已变化，请在工作台对照当前资料与历史版本")
    labels = {
        "definition": "定义",
        "principle": "原理",
        "parameter": "参数",
        "scope": "适用范围",
    }
    cards = [
        {
            "term": card["term"],
            "missing": [
                label for field, label in labels.items() if not card.get(field)
            ],
        }
        for card in workspace["cards"]
    ]
    summary = [
        card["term"]
        + (
            "（待补：" + "、".join(card["missing"]) + "）"
            if card["missing"]
            else "（字段齐全）"
        )
        for card in cards
    ]
    issues = [issue["message"] for issue in workspace["issues"]]
    status = (
        "提取完成，候选已保存。" if decision.action == "extract" else "已读取工作区。"
    )
    if decision.action == "save":
        status = "字段草稿已保存。"
    reply = "\n".join(
        [
            f"{status} 工程版本 {workspace['revision']}，共 {len(cards)} 张卡片。",
            *summary,
            *(f"待核实：{issue}" for issue in issues),
        ]
    )
    focus = None
    if decision.card_number is not None:
        if 1 <= decision.card_number <= len(cards):
            card = workspace["cards"][decision.card_number - 1]
            focus = {"card_id": card["id"], "field": decision.field}
            anchor = (card.get("sources") or {}).get(decision.field)
            reply += f"\n已定位：{card['term']}。"
            if anchor:
                reply += f"原文第 {anchor['line_start']}–{anchor['line_end']} 行。"
        else:
            reply += f"\n当前没有第 {decision.card_number} 张卡片。"
    return {
        "action": decision.action,
        "reply": reply,
        "revision": workspace["revision"],
        "focus": focus,
        "snapshot": {
            "source": {key: value for key, value in source.items() if key != "text"},
            "cards": workspace["cards"],
            "issues": workspace["issues"],
        }
        if decision.action in {"extract", "save"}
        else None,
    }


class WorkbenchJobRequest(WorkbenchChatRequest):
    request_id: str = Field(pattern=r"^[a-f0-9-]{36}$")


@router.post("/workbench/jobs", status_code=202)
async def start_workbench_job(
    request: WorkbenchJobRequest,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_effective_user_id),
) -> dict[str, Any]:
    from backend.services.studio_chat_jobs import scope_for, submit_job

    source = await read_studio_source(
        db, request.project_id, request.file_id, request.file_kind, user_id
    )
    return await submit_job(
        scope_for(user_id, source), request.request_id, request.message, source
    )


@router.get("/workbench/jobs/{request_id}")
async def read_workbench_job(
    request_id: str,
    project_id: str,
    file_id: str,
    file_kind: Literal["output", "attachment"],
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_effective_user_id),
) -> dict[str, Any]:
    import asyncio

    from backend.services.studio_chat_jobs import get_job, scope_for

    source = await read_studio_source(db, project_id, file_id, file_kind, user_id)
    return await asyncio.to_thread(get_job, scope_for(user_id, source), request_id)


class CutPotRequest(BaseModel):
    project_id: str
    action: Literal["connect", "show", "rename", "disconnect"]
    name: str | None = Field(default=None, min_length=1, max_length=120)
    expected_revision: str | None = None


@router.post("/cutpot")
async def cutpot_workbench(
    request: CutPotRequest,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_effective_user_id),
) -> dict[str, Any]:
    from backend.services.cutpot_workbench import call_cutpot
    from backend.services.project_access import (
        project_owner_id,
        require_project_for_user,
    )

    project = await require_project_for_user(
        db, request.project_id, user_id, min_perm="write"
    )
    if project_owner_id(project) != user_id:
        raise HTTPException(403, "CutPot 本机工程仅供项目所有者操作")
    if request.action in {"connect", "disconnect"}:
        data = await call_cutpot(request.project_id, request.action)
        if request.action == "connect":
            from backend.services.project_session_service import record_cutpot_reference

            await record_cutpot_reference(
                db, project_id=request.project_id, user_id=user_id, detail=data
            )
        return data
    if request.action == "show":
        return await call_cutpot(request.project_id, "turn")
    if not request.name or not request.name.strip() or not request.expected_revision:
        raise HTTPException(422, "请提供新名称和当前 CutPot 工程版本")
    return await call_cutpot(
        request.project_id,
        "turn",
        "project-rename",
        name=request.name,
        expected_revision=request.expected_revision,
    )


class CutPotInstruction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: Literal["show", "rename", "unsupported"]
    name: str | None = Field(default=None, min_length=1, max_length=120)


class CutPotChatRequest(BaseModel):
    project_id: str
    message: str = Field(min_length=1, max_length=1000)


@router.post("/cutpot/chat")
async def cutpot_chat(
    request: CutPotChatRequest,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_effective_user_id),
) -> dict[str, Any]:
    from backend.services.studio_agent import classify_workbench_instruction

    async def perform(action, **fields):
        return await cutpot_workbench(
            CutPotRequest(project_id=request.project_id, action=action, **fields),
            db,
            user_id,
        )

    state = await perform("show")
    decision = await classify_workbench_instruction(
        request.message,
        "你只负责分类 CutPot 工程指令，不调用工具。直接输出 JSON。"
        '查询工程输出 {"action":"show"}。明确要求改名才输出 {"action":"rename","name":"用户指定的原名"}。'
        '其余输出 {"action":"unsupported"}。',
        CutPotInstruction,
    )
    if decision.action == "unsupported":
        return {"reply": "目前支持查看和重命名 CutPot 工程。"}
    if decision.action == "rename":
        quoted = re.search(r'「([^」]+)」|“([^”]+)”|"([^"]+)"', request.message)
        name = (
            next((part for part in quoted.groups() if part), None)
            if quoted
            else decision.name
        )
        if (
            not name
            or not name.strip()
            or len(name) > 120
            or name not in request.message
        ):
            raise HTTPException(422, "请在对话中明确写出新的工程名称")
        state = await perform("rename", name=name, expected_revision=state["revision"])
    return {**state, "reply": f"CutPot 工程：{state['project']['name']}"}


class AppWorkspaceRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    operation: str = Field(min_length=1, max_length=40)
    project_id: str = Field(min_length=1, max_length=80)


class AppChatRequest(BaseModel):
    project_id: str = Field(min_length=1, max_length=80)
    message: str = Field(min_length=1, max_length=200)


class EngineeringRequest(BaseModel):
    action: Literal["export", "import"]
    product: Literal["V04", "V05", "V10"]
    project_id: str = Field(min_length=1, max_length=80)
    file_id: str | None = None
    file_kind: Literal["output", "attachment"] | None = None


@router.post("/engineering")
async def engineering_transfer(
    request: EngineeringRequest,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_effective_user_id),
) -> dict[str, Any]:
    from backend.services.studio_engineering import export_engineering_file, import_engineering_file

    if request.action == "export":
        return await export_engineering_file(
            db,
            user_id=user_id,
            product=request.product,
            project_id=request.project_id,
            file_id=request.file_id,
            file_kind=request.file_kind,
        )
    if not request.file_id:
        raise HTTPException(422, "请先在项目文件中选择要导入的工程文件")
    return await import_engineering_file(
        db,
        user_id=user_id,
        product=request.product,
        project_id=request.project_id,
        file_id=request.file_id,
    )


@router.get("/apps/{product}/page", response_class=PlainTextResponse)
async def app_workbench_page(product: str) -> str:
    from backend.services.tpcstore_bridge import APP_PRODUCTS, read_workbench_html

    if product not in APP_PRODUCTS:
        raise HTTPException(404, "未接入的技能卡")
    return read_workbench_html(product)


@router.get("/apps/{product}/fixture")
async def app_fixture(product: str) -> dict[str, Any]:
    from backend.services.tpcstore_bridge import read_product_fixture

    return read_product_fixture(product)


@router.post("/apps/{product}/workspace")
async def app_workspace(
    product: str,
    request: AppWorkspaceRequest,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_effective_user_id),
) -> dict[str, Any]:
    from backend.services.studio_apps import run_app_workspace

    return await run_app_workspace(
        db,
        product=product,
        user_id=user_id,
        payload=request.model_dump(),
    )


@router.post("/apps/{product}/chat")
async def app_chat(
    product: str,
    request: AppChatRequest,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_effective_user_id),
) -> dict[str, Any]:
    from backend.services.studio_apps import run_app_chat

    return await run_app_chat(
        db,
        product=product,
        user_id=user_id,
        project_id=request.project_id,
        message=request.message,
    )
