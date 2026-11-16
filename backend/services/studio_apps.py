"""V05 / V10 工作台：宿主校验项目后调用对应 CLI，工程目录与 V04 分开。"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.services.project_access import require_project_for_user
from backend.services.tpcstore_bridge import (
    APP_OPERATIONS,
    APP_PRODUCTS,
    call_tpcstore,
    read_product_fixture,
)

logger = logging.getLogger("tpdx.hermes.studio_apps")


async def run_app_workspace(
    db: AsyncSession,
    *,
    product: str,
    user_id: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    if product not in APP_PRODUCTS:
        raise HTTPException(404, "未接入的技能卡")
    operation = str(payload.get("operation") or "")
    if operation not in APP_OPERATIONS[product]:
        raise HTTPException(422, "该技能卡不支持此操作")
    project_id = str(payload.get("project_id") or "").strip()
    await require_project_for_user(db, project_id, user_id, min_perm="write")
    from backend.services.project_session_service import attach_scene_scope

    body = {key: value for key, value in payload.items() if value is not None}
    body["operation"] = operation
    body["project_id"] = project_id
    body = await attach_scene_scope(
        db, project_id=project_id, product=product, user_id=user_id, payload=body
    )
    logger.info(
        "studio app workspace product=%s project_id=%s operation=%s",
        product,
        project_id,
        operation,
    )
    return await call_tpcstore("workspace", body, product=product, needs_model=False)


def _has_content(product: str, data: dict[str, Any]) -> bool:
    if product == "V05":
        return bool(data.get("facts"))
    if product == "V07":
        return bool(data.get("messages") or data.get("values") or data.get("claims"))
    return bool(data.get("claims") or data.get("evidence"))


def summarize(product: str, data: dict[str, Any]) -> str:
    revision = data.get("revision", 0)
    if product == "V05":
        return (
            f"价值链工程 revision {revision} · 事实 {len(data.get('facts') or [])} · "
            f"关系 {len(data.get('links') or [])} · 价值卡 {len(data.get('cards') or [])}。正式放行否。"
        )
    if product == "V07":
        current = [
            item for item in (data.get("messages") or [])
            if isinstance(item, dict) and item.get("status") != "superseded"
        ]
        counts = {level: sum(1 for item in current if item.get("level") == level) for level in ("roof", "pillar", "base")}
        return (
            f"信息屋工程 revision {revision} · 屋顶 {counts['roof']} · "
            f"支柱 {counts['pillar']} · 底座 {counts['base']}。正式放行否。"
        )
    return (
        f"主张证据工程 revision {revision} · 主张 {len(data.get('claims') or [])} · "
        f"证据 {len(data.get('evidence') or [])} · 关系 {len(data.get('links') or [])}。正式放行否。"
    )


async def run_app_chat(
    db: AsyncSession,
    *,
    product: str,
    user_id: str,
    project_id: str,
    message: str,
) -> dict[str, Any]:
    text = message.strip()
    if text in {"查看工程", "查看工作区"}:
        data = await run_app_workspace(
            db,
            product=product,
            user_id=user_id,
            payload={"operation": "show", "project_id": project_id},
        )
        return {"reply": summarize(product, data), "revision": data.get("revision")}
    if text == "导出草稿":
        data = await run_app_workspace(
            db,
            product=product,
            user_id=user_id,
            payload={"operation": "export", "project_id": project_id},
        )
        return {
            "reply": f"已导出草稿。{summarize(product, data)}",
            "revision": data.get("revision"),
        }
    if text == "载入示例":
        current = await run_app_workspace(
            db,
            product=product,
            user_id=user_id,
            payload={"operation": "show", "project_id": project_id},
        )
        if _has_content(product, current):
            return {
                "reply": f"工程已有内容，未重复导入。{summarize(product, current)}",
                "revision": current.get("revision"),
            }
        fixture = read_product_fixture(product)
        revision = int(current.get("revision") or 0)
        payload: dict[str, Any] = {
            "operation": "import",
            "project_id": project_id,
            "expected_revision": revision,
            "idempotency_key": f"hermes-{product.lower()}-fixture-{revision}",
        }
        if product == "V05":
            payload["facts"] = fixture.get("facts") or []
            payload["apply_draft"] = True
            payload["draft"] = {
                "scenario": fixture.get("scenario"),
                "derivation": fixture.get("derivation"),
                "benefit": fixture.get("benefit"),
                "unverified_claim": fixture.get("unverified_claim"),
                "target_user": fixture.get("target_user"),
            }
        elif product == "V07":
            payload["audience"] = fixture.get("audience")
            payload["purpose"] = fixture.get("purpose")
            payload["values"] = fixture.get("values") or []
            payload["evidence"] = fixture.get("evidence") or []
            payload["claims"] = fixture.get("claims") or []
            payload["messages"] = fixture.get("messages") or []
        else:
            payload["claims"] = fixture.get("claims") or []
            payload["evidence"] = fixture.get("evidence") or []
        data = await run_app_workspace(
            db, product=product, user_id=user_id, payload=payload
        )
        return {"reply": f"已载入示例。{summarize(product, data)}", "revision": data.get("revision")}
    return {
        "reply": "可以查看工程、载入示例或导出草稿。编辑和核对在右侧工作台进行。",
        "revision": None,
    }
