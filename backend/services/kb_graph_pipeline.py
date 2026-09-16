"""
三层知识共用的向量后图谱总线：节点 upsert、带权威的边、KbKgLink。

authority：canonical（GeelyWiki equipped_with）> experience > supplement（外部情报）。
弱边不得把 CONTAINS_TECH 写成已确认搭载。
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from backend.db import async_session_maker
from backend.models.kb_kg_link import KbKgLink
from backend.models.kg_entities import KgRelation
from backend.services.kb_contract import (
    AUTHORITY_CANONICAL,
    AUTHORITY_RANK,
    AUTHORITY_SUPPLEMENT,
)
from backend.services.kg_service import (
    NODE_KINDS,
    REL_TYPES,
    kg_store_service,
)

logger = logging.getLogger("tpdx.hermes.kb_graph")

RELATED_TO = "RELATED_TO"


def slug_node_id(prefix: str, slug: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "_", (slug or "").strip()).strip("_")
    return f"{prefix}_{cleaned or 'unknown'}"[:80]


def authority_rank(value: str | None) -> int:
    return AUTHORITY_RANK.get(str(value or "").strip() or AUTHORITY_SUPPLEMENT, 0)


async def upsert_kg_node(kind: str, data: dict[str, Any]) -> dict[str, Any]:
    return await kg_store_service.upsert_node(kind, data)


async def link_kb_to_kg(
    *,
    kb_entry_id: str,
    kb_project_id: str = "__all__",
    kg_kind: str,
    kg_node_id: str,
) -> Optional[dict[str, Any]]:
    if kg_kind not in NODE_KINDS or not kb_entry_id or not kg_node_id:
        return None
    async with async_session_maker() as db:
        existing = (
            await db.execute(
                select(KbKgLink).where(
                    KbKgLink.kb_entry_id == kb_entry_id,
                    KbKgLink.kb_project_id == kb_project_id,
                    KbKgLink.kg_kind == kg_kind,
                    KbKgLink.kg_node_id == kg_node_id,
                )
            )
        ).scalar_one_or_none()
        if existing:
            return {c.name: getattr(existing, c.name, None) for c in existing.__table__.columns}
        row = KbKgLink(
            id=str(uuid.uuid4()),
            kb_entry_id=kb_entry_id,
            kb_project_id=kb_project_id,
            kg_kind=kg_kind,
            kg_node_id=kg_node_id,
            created_at=datetime.now().isoformat(),
        )
        db.add(row)
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            return None
        return {c.name: getattr(row, c.name, None) for c in row.__table__.columns}


async def upsert_relation_with_authority(
    *,
    rel_type: str,
    src_kind: str,
    src_id: str,
    dst_kind: str,
    dst_id: str,
    source: str,
    authority: str,
    source_collection: str = "",
    evidence_kind: str = "",
) -> dict[str, Any]:
    """按权威写入边。canonical CONTAINS_TECH 不被 supplement 覆盖或改写。"""
    rel_type = rel_type.upper()
    if rel_type not in REL_TYPES:
        raise ValueError("bad rel_type")
    if src_kind not in NODE_KINDS or dst_kind not in NODE_KINDS:
        raise ValueError("bad node kind")
    auth = authority or AUTHORITY_SUPPLEMENT
    if rel_type == "CONTAINS_TECH" and authority_rank(auth) < authority_rank(AUTHORITY_CANONICAL):
        logger.info(
            "kg skip weak CONTAINS_TECH src=%s dst=%s authority=%s",
            src_id,
            dst_id,
            auth,
        )
        return {
            "skipped": True,
            "reason": "weak_contains_tech",
            "rel_type": rel_type,
            "src_id": src_id,
            "dst_id": dst_id,
        }

    async with async_session_maker() as db:
        existing = (
            await db.execute(
                select(KgRelation).where(
                    KgRelation.rel_type == rel_type,
                    KgRelation.src_kind == src_kind,
                    KgRelation.src_id == src_id,
                    KgRelation.dst_kind == dst_kind,
                    KgRelation.dst_id == dst_id,
                )
            )
        ).scalar_one_or_none()
        if existing:
            old_rank = authority_rank(str(getattr(existing, "authority", "") or ""))
            new_rank = authority_rank(auth)
            if new_rank < old_rank:
                logger.info(
                    "kg keep stronger edge id=%s old=%s new=%s",
                    existing.id,
                    existing.authority,
                    auth,
                )
                return {
                    "id": existing.id,
                    "skipped": True,
                    "reason": "weaker_authority",
                    "authority": getattr(existing, "authority", None),
                    "rel_type": rel_type,
                }
            setattr(existing, "source", source)
            setattr(existing, "authority", auth)
            setattr(existing, "source_collection", source_collection or existing.source_collection)
            setattr(existing, "evidence_kind", evidence_kind or existing.evidence_kind)
            await db.commit()
            return {c.name: getattr(existing, c.name, None) for c in existing.__table__.columns}

        row = KgRelation(
            id=str(uuid.uuid4()),
            rel_type=rel_type,
            src_kind=src_kind,
            src_id=src_id,
            dst_kind=dst_kind,
            dst_id=dst_id,
            source=source,
            authority=auth,
            source_collection=source_collection,
            evidence_kind=evidence_kind,
        )
        db.add(row)
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            retry = (
                await db.execute(
                    select(KgRelation).where(
                        KgRelation.rel_type == rel_type,
                        KgRelation.src_kind == src_kind,
                        KgRelation.src_id == src_id,
                        KgRelation.dst_kind == dst_kind,
                        KgRelation.dst_id == dst_id,
                    )
                )
            ).scalar_one_or_none()
            if retry:
                return {c.name: getattr(retry, c.name, None) for c in retry.__table__.columns}
            raise
        logger.info(
            "kg relation upserted type=%s src=%s dst=%s authority=%s source=%s",
            rel_type,
            src_id,
            dst_id,
            auth,
            source,
        )
        return {c.name: getattr(row, c.name, None) for c in row.__table__.columns}


async def apply_kg_bundle(
    bundle: dict[str, Any],
    *,
    kb_entry_id: str | None = None,
    kb_project_id: str = "__all__",
) -> dict[str, int]:
    """应用纯数据 bundle（brands/vehicles/core_techs/insights/relations）。抽图失败由调用方吞掉。"""
    counts = {
        "brands": 0,
        "vehicles": 0,
        "core_techs": 0,
        "tech_insights": 0,
        "relations": 0,
        "links": 0,
        "skipped_relations": 0,
    }
    try:
        for row in bundle.get("brands") or []:
            if isinstance(row, dict) and row.get("brand_id"):
                await upsert_kg_node("Brand", row)
                counts["brands"] += 1
                if kb_entry_id:
                    await link_kb_to_kg(
                        kb_entry_id=kb_entry_id,
                        kb_project_id=kb_project_id,
                        kg_kind="Brand",
                        kg_node_id=str(row["brand_id"]),
                    )
                    counts["links"] += 1
        for row in bundle.get("vehicles") or []:
            if isinstance(row, dict) and row.get("vehicle_id"):
                await upsert_kg_node("Vehicle", row)
                counts["vehicles"] += 1
                if kb_entry_id:
                    await link_kb_to_kg(
                        kb_entry_id=kb_entry_id,
                        kb_project_id=kb_project_id,
                        kg_kind="Vehicle",
                        kg_node_id=str(row["vehicle_id"]),
                    )
                    counts["links"] += 1
        for row in bundle.get("core_techs") or []:
            if isinstance(row, dict) and row.get("tech_id"):
                await upsert_kg_node("CoreTech", row)
                counts["core_techs"] += 1
                if kb_entry_id:
                    await link_kb_to_kg(
                        kb_entry_id=kb_entry_id,
                        kb_project_id=kb_project_id,
                        kg_kind="CoreTech",
                        kg_node_id=str(row["tech_id"]),
                    )
                    counts["links"] += 1
        for row in bundle.get("tech_insights") or []:
            if isinstance(row, dict) and row.get("insight_id"):
                await upsert_kg_node("TechInsight", row)
                counts["tech_insights"] += 1
                if kb_entry_id:
                    await link_kb_to_kg(
                        kb_entry_id=kb_entry_id,
                        kb_project_id=kb_project_id,
                        kg_kind="TechInsight",
                        kg_node_id=str(row["insight_id"]),
                    )
                    counts["links"] += 1
        for rel in bundle.get("relations") or []:
            if not isinstance(rel, dict):
                continue
            result = await upsert_relation_with_authority(
                rel_type=str(rel.get("rel_type") or ""),
                src_kind=str(rel.get("src_kind") or ""),
                src_id=str(rel.get("src_id") or ""),
                dst_kind=str(rel.get("dst_kind") or ""),
                dst_id=str(rel.get("dst_id") or ""),
                source=str(rel.get("source") or ""),
                authority=str(rel.get("authority") or AUTHORITY_SUPPLEMENT),
                source_collection=str(rel.get("source_collection") or ""),
                evidence_kind=str(rel.get("evidence_kind") or ""),
            )
            if result.get("skipped"):
                counts["skipped_relations"] += 1
            else:
                counts["relations"] += 1
    except Exception:
        logger.exception("apply_kg_bundle failed kb_entry_id=%s", kb_entry_id)
    return counts
