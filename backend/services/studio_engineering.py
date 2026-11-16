"""技能卡通过项目工程文件交接，不读取其他卡片的本机数据目录。"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.output_asset import OutputAsset
from backend.services.project_access import require_project_for_user
from backend.services.studio_apps import run_app_workspace
from backend.services.tpcstore_bridge import call_tpcstore, read_studio_source

logger = logging.getLogger("tpdx.hermes.studio_engineering")

KIND = "tpcstore.engineering"
TITLES = {
    "V04": "V04 技术卡工程",
    "V05": "V05 价值链工程",
    "V07": "V07 信息屋工程",
    "V10": "V10 主张证据工程",
}
ACCEPTS = {"V05": "V04", "V07": "V10", "V10": "V05"}


def facts_from_v04(data: dict[str, Any]) -> list[dict[str, Any]]:
    source_id = str((data.get("source") or {}).get("id") or "v04")
    facts: list[dict[str, Any]] = []
    for card in data.get("cards") or []:
        if not isinstance(card, dict) or card.get("status") in {"rejected", "stale"}:
            continue
        card_id = str(card.get("id") or "card")
        version = str(card.get("adopted_version") or card.get("version") or 1)
        rows = (
            ("principle", card.get("principle"), f"{card_id}/principle", "原理"),
            ("capability", card.get("definition"), f"{card_id}/capability", str(card.get("term") or "能力")),
            ("scenario", card.get("scope"), f"{card_id}/scenario", "适用范围"),
            ("parameter", card.get("parameter"), f"{card_id}/parameter", "参数"),
        )
        for kind, raw, object_id, title in rows:
            text = str(raw or "").strip()
            if not text:
                continue
            facts.append({
                "object_id": object_id,
                "version_id": version,
                "source_id": source_id,
                "kind": kind,
                "title": title[:200],
                "text": text,
            })
    return facts


def _scope(card: dict[str, Any]) -> list[dict[str, Any]]:
    raw = card.get("conditions")
    if isinstance(raw, list) and raw:
        scope = []
        for item in raw:
            if not isinstance(item, dict) or not str(item.get("name") or "").strip():
                continue
            status = str(item.get("status") or "specific")
            value = item.get("value")
            if status != "specific":
                scope.append({"name": str(item["name"]), "status": status, "value": None})
            elif value:
                scope.append({"name": str(item["name"]), "status": "specific", "value": str(value)})
        if scope:
            return scope
    scenario = str(card.get("scenario") or "").strip()
    if scenario:
        return [{"name": "场景", "status": "specific", "value": scenario}]
    return [{"name": "场景", "status": "unknown", "value": None}]


def claims_from_v05(data: dict[str, Any]) -> list[dict[str, Any]]:
    claims: list[dict[str, Any]] = []
    for card in data.get("cards") or []:
        if not isinstance(card, dict):
            continue
        for claim in card.get("claims") or []:
            if not isinstance(claim, dict):
                continue
            text = str(claim.get("text") or "").strip()
            if not text:
                continue
            claims.append({
                "claim_id": str(claim.get("id") or f"claim/{len(claims) + 1}"),
                "version": str(claim.get("version") or 1),
                "text": text,
                "metric": str(card.get("benefit") or "未标明指标"),
                "baseline": "比较基线未在价值链工程中给出",
                "strength": "待验证",
                "source_id": str(card.get("id") or "v05"),
                "scope": _scope(card),
                "population": [],
            })
    return claims


def engineering_document(product: str, data: dict[str, Any]) -> dict[str, Any]:
    if product == "V04":
        facts = facts_from_v04(data)
        if not facts:
            raise HTTPException(422, "当前技术卡没有可交给价值链的事实")
        body = {"facts": facts, "draft_markdown": str((data.get("draft") or {}).get("markdown") or "")}
    elif product == "V05":
        claims = claims_from_v05(data)
        if not claims:
            raise HTTPException(422, "当前价值链没有可交给主张匹配的主张")
        body = {"claims": claims, "facts": data.get("facts") or [], "draft_markdown": str((data.get("draft") or {}).get("card_markdown") or "")}
    elif product == "V10":
        body = {
            "claims": data.get("claims") or [],
            "evidence": data.get("evidence") or [],
            "draft_markdown": str((data.get("draft") or {}).get("checklist_markdown") or ""),
        }
        if not body["claims"] and not body["evidence"]:
            raise HTTPException(422, "当前主张证据工程没有可交出的内容")
    elif product == "V07":
        house = data.get("house") if isinstance(data.get("house"), dict) else {}
        messages = [
            item for item in (data.get("messages") or [])
            if isinstance(item, dict) and item.get("status") != "superseded"
        ]
        body = {
            "audience": house.get("audience"),
            "purpose": house.get("purpose"),
            "values": data.get("values") or [],
            "claims": data.get("claims") or [],
            "evidence": data.get("evidence") or [],
            "messages": messages,
            "draft_markdown": str((data.get("draft") or {}).get("markdown") or ""),
        }
        if not body["values"] and not body["claims"] and not body["messages"]:
            raise HTTPException(422, "当前信息屋没有可交出的口径")
    else:
        raise HTTPException(404, "该技能卡不能写入工程文件")
    return {
        "schema_version": "1.0.0",
        "kind": KIND,
        "product": product,
        "revision": data.get("revision"),
        "release_authorized": False,
        **body,
    }


async def _workspace(db: AsyncSession, user_id: str, product: str, project_id: str, file_id: str | None, file_kind: str | None) -> dict[str, Any]:
    if product == "V04":
        if not file_id or file_kind not in {"output", "attachment"}:
            raise HTTPException(422, "请先选择技术卡正在使用的项目资料")
        source = await read_studio_source(db, project_id, file_id, file_kind, user_id)
        from backend.services.project_session_service import attach_scene_scope

        scoped = await attach_scene_scope(
            db,
            project_id=project_id,
            product="V04",
            user_id=user_id,
            payload={"operation": "show", "source": source},
        )
        return await call_tpcstore("workspace", scoped, product="V04", needs_model=False)
    return await run_app_workspace(db, product=product, user_id=user_id, payload={"operation": "show", "project_id": project_id})


async def _save_output(db: AsyncSession, project_id: str, user_id: str, product: str, document: dict[str, Any]) -> OutputAsset:
    now = datetime.now().isoformat()
    content = json.dumps(document, ensure_ascii=False)
    from backend.services.project_session_service import ensure_project_session, scene_source_id

    origin = await ensure_project_session(
        db,
        project_id=project_id,
        kind="scene",
        source_id=scene_source_id(product, project_id),
        source_kind="studio",
        title=TITLES[product],
        owner_id=user_id or "default",
        commit=False,
    )
    row = OutputAsset(
        id=str(uuid4()),
        project_id=project_id,
        title=TITLES[product],
        summary=f"{TITLES[product]} · revision {document.get('revision')}",
        content=content,
        content_format="json",
        version="1",
        status="draft",
        owner_id=user_id or "default",
        session_id=origin.id,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    logger.info(
        "studio engineering export product=%s project_id=%s output_id=%s",
        product,
        project_id,
        row.id,
    )
    return row


async def export_engineering_file(
    db: AsyncSession,
    *,
    user_id: str,
    product: str,
    project_id: str,
    file_id: str | None = None,
    file_kind: str | None = None,
) -> dict[str, Any]:
    data = await _workspace(db, user_id, product, project_id, file_id, file_kind)
    document = engineering_document(product, data)
    row = await _save_output(db, project_id, user_id, product, document)
    return {
        "reply": f"已写入工程文件「{row.title}」。下游技能卡请选择这份文件再导入。正式放行否。",
        "file_id": row.id,
        "file_kind": "output",
        "title": row.title,
        "revision": data.get("revision"),
    }


async def import_engineering_file(
    db: AsyncSession,
    *,
    user_id: str,
    product: str,
    project_id: str,
    file_id: str,
) -> dict[str, Any]:
    expected = ACCEPTS.get(product)
    if not expected:
        raise HTTPException(422, "技术卡从项目资料提取，不从其他技能卡的工程文件导入")
    await require_project_for_user(db, project_id, user_id, min_perm="write")
    row = (
        await db.execute(
            select(OutputAsset).where(
                OutputAsset.id == file_id,
                OutputAsset.project_id == project_id,
                OutputAsset.status != "archived",
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "工程文件不存在")
    try:
        document = json.loads(row.content or "")
    except json.JSONDecodeError as exc:
        raise HTTPException(422, "所选文件不是技能卡工程文件") from exc
    if not isinstance(document, dict) or document.get("kind") != KIND:
        raise HTTPException(422, "所选文件不是技能卡工程文件")
    if document.get("product") != expected:
        raise HTTPException(422, f"{TITLES.get(product, product)}只能接收{TITLES[expected]}")
    current = await run_app_workspace(
        db, product=product, user_id=user_id, payload={"operation": "show", "project_id": project_id}
    )
    payload: dict[str, Any] = {
        "operation": "import",
        "project_id": project_id,
        "expected_revision": int(current.get("revision") or 0),
        "idempotency_key": f"import-{product}-{str(row.id)[:24]}-v{row.version or 1}"[:120],
    }
    if product == "V05":
        payload["facts"] = document.get("facts") or []
        if not payload["facts"]:
            raise HTTPException(422, "这份技术卡工程没有可导入的事实")
    elif product == "V07":
        claims = [item for item in (document.get("claims") or []) if isinstance(item, dict)]
        evidence = []
        for item in document.get("evidence") or []:
            if not isinstance(item, dict) or not str(item.get("evidence_id") or "").strip():
                continue
            evidence.append({
                "evidence_id": str(item.get("evidence_id")),
                "version": str(item.get("version") or "1"),
                "source_id": str(item.get("source_id") or item.get("evidence_id")),
                "locator": str(item.get("locator") or "未标明位置"),
                "result": str(item.get("result") or "未记录结果"),
                "unit": str(item.get("unit") or "未标明单位"),
                "conditions": item.get("conditions") if isinstance(item.get("conditions"), list) else [],
            })
        values = []
        for claim in claims:
            text = str(claim.get("text") or "").strip()
            claim_id = str(claim.get("claim_id") or "").strip()
            if not text or not claim_id:
                continue
            values.append({
                "object_id": claim_id,
                "version_id": str(claim.get("version") or "1"),
                "source_id": str(claim.get("source_id") or claim_id),
                "role": "pillar",
                "title": text[:80],
                "text": text,
                "conditions": claim.get("scope") if isinstance(claim.get("scope"), list) else [],
            })
        if not values and not evidence:
            raise HTTPException(422, "这份主张证据工程没有可导入的主张或证据")
        payload["claims"] = [
            {
                "claim_id": str(claim.get("claim_id")),
                "version": str(claim.get("version") or "1"),
                "text": str(claim.get("text") or ""),
                "strength": str(claim.get("strength") or "待验证"),
                "metric": str(claim.get("metric") or "未标明指标"),
                "source_id": str(claim.get("source_id") or claim.get("claim_id")),
            }
            for claim in claims
            if str(claim.get("text") or "").strip() and str(claim.get("claim_id") or "").strip()
        ]
        payload["evidence"] = evidence
        payload["values"] = values
    else:
        payload["claims"] = document.get("claims") or []
        payload["evidence"] = document.get("evidence") or []
        if not payload["claims"] and not payload["evidence"]:
            raise HTTPException(422, "这份价值链工程没有可导入的主张")
    saved = await run_app_workspace(db, product=product, user_id=user_id, payload=payload)
    logger.info(
        "studio engineering import product=%s project_id=%s file_id=%s revision=%s",
        product,
        project_id,
        file_id,
        saved.get("revision"),
    )
    return {
        "reply": f"已从「{row.title}」导入到{TITLES[product]}。revision {saved.get('revision')}。正式放行否。",
        "revision": saved.get("revision"),
    }
