"""知识图谱 HTTP API（节点/关系/导入导出/校验）。"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from backend.services.kg_service import NODE_KINDS, REL_TYPES, kg_store_service

logger = logging.getLogger("tpdx.hermes")

router = APIRouter(prefix="/kg", tags=["knowledge_graph"])


class KgNodeUpsertBody(BaseModel):
    data: dict[str, Any] = Field(default_factory=dict)


class KgRelationBody(BaseModel):
    rel_type: str
    src_kind: str
    src_id: str
    dst_kind: str
    dst_id: str


class KgImportBundleBody(BaseModel):
    brands: list[dict[str, Any]] | None = None
    vehicles: list[dict[str, Any]] | None = None
    tech_insights: list[dict[str, Any]] | None = None
    planned_vehicles: list[dict[str, Any]] | None = None
    core_techs: list[dict[str, Any]] | None = None
    relations: list[dict[str, Any]] | None = None


@router.get("/stats")
async def kg_stats():
    return await kg_store_service.stats()


@router.get("/validate")
async def kg_validate():
    return await kg_store_service.validate()


@router.get("/export")
async def kg_export():
    return await kg_store_service.export_bundle()


@router.post("/import")
async def kg_import(body: KgImportBundleBody):
    payload = body.model_dump(exclude_none=True)
    try:
        counts = await kg_store_service.import_bundle(payload)
    except Exception as e:
        logger.exception("kg import failed")
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"ok": True, "counts": counts}


@router.get("/nodes/{kind}")
async def kg_list_nodes(
    kind: str,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    if kind not in NODE_KINDS:
        raise HTTPException(status_code=400, detail=f"未知 kind，可选: {sorted(NODE_KINDS)}")
    return {"kind": kind, "items": await kg_store_service.list_nodes(kind, limit=limit, offset=offset)}


@router.get("/nodes/{kind}/{node_id}")
async def kg_get_node(kind: str, node_id: str):
    row = await kg_store_service.get_node(kind, node_id)
    if not row:
        raise HTTPException(status_code=404, detail="节点不存在")
    return row


@router.post("/nodes/{kind}")
async def kg_upsert_node(kind: str, body: KgNodeUpsertBody):
    if kind not in NODE_KINDS:
        raise HTTPException(status_code=400, detail="未知 kind")
    try:
        row = await kg_store_service.upsert_node(kind, body.data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return row


@router.delete("/nodes/{kind}/{node_id}")
async def kg_delete_node(kind: str, node_id: str):
    ok = await kg_store_service.delete_node(kind, node_id)
    if not ok:
        raise HTTPException(status_code=404, detail="节点不存在")
    return {"ok": True}


@router.get("/relations")
async def kg_list_relations(
    rel_type: str | None = None,
    limit: int = Query(100, ge=1, le=500),
):
    if rel_type and rel_type.upper() not in REL_TYPES:
        raise HTTPException(status_code=400, detail=f"未知关系类型 {rel_type}")
    return {"items": await kg_store_service.list_relations(rel_type=rel_type, limit=limit)}


@router.post("/relations")
async def kg_add_relation(body: KgRelationBody):
    try:
        row = await kg_store_service.add_relation(
            body.rel_type,
            body.src_kind,
            body.src_id,
            body.dst_kind,
            body.dst_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        logger.warning("kg add_relation duplicate or constraint: %s", e)
        raise HTTPException(status_code=409, detail="关系已存在或约束冲突") from e
    return row


@router.delete("/relations/{rel_id}")
async def kg_delete_relation(rel_id: str):
    ok = await kg_store_service.delete_relation(rel_id)
    if not ok:
        raise HTTPException(status_code=404, detail="关系不存在")
    return {"ok": True}
