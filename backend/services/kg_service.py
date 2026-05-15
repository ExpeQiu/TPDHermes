"""
知识图谱：CRUD、批量导入、统计与一致性校验。
"""

from __future__ import annotations

import logging
import uuid
from collections import Counter
from datetime import datetime
from typing import Any

from sqlalchemy import delete, func, or_, select
from sqlalchemy.exc import IntegrityError

from backend.db import async_session_maker
from backend.models.kb_kg_link import KbKgLink
from backend.models.kg_entities import (
    KgBrand,
    KgCoreTech,
    KgPlannedVehicle,
    KgRelation,
    KgTechInsight,
    KgVehicle,
)

logger = logging.getLogger("tpdx.hermes")

NODE_KINDS = frozenset({"Brand", "Vehicle", "TechInsight", "CoreTech", "PlannedVehicle"})
REL_TYPES = frozenset({"OWNS", "HAS_INSIGHT", "CONTAINS_TECH", "PLANNED_BY"})

_MODEL_BY_KIND: dict[str, type] = {
    "Brand": KgBrand,
    "Vehicle": KgVehicle,
    "TechInsight": KgTechInsight,
    "CoreTech": KgCoreTech,
    "PlannedVehicle": KgPlannedVehicle,
}

_ID_FIELD = {
    "Brand": "brand_id",
    "Vehicle": "vehicle_id",
    "TechInsight": "insight_id",
    "CoreTech": "tech_id",
    "PlannedVehicle": "planned_id",
}


def _now() -> str:
    return datetime.now().isoformat()


def _entity_dict(model: type, row: dict[str, Any]) -> dict[str, Any]:
    keys = [c.name for c in model.__table__.columns]
    return {k: row.get(k) for k in keys}


async def _upsert_row(db: Any, model: type, id_attr: str, row: dict[str, Any]) -> None:
    data = _entity_dict(model, row)
    pk = data.get(id_attr)
    if not pk:
        return
    existing = await db.get(model, str(pk))
    if existing:
        for k, v in data.items():
            if k != id_attr and hasattr(existing, k):
                setattr(existing, k, v)
    else:
        db.add(model(**data))


class KgStoreService:
    async def stats(self) -> dict[str, Any]:
        async with async_session_maker() as db:
            n_brand = await db.scalar(select(func.count()).select_from(KgBrand))
            n_vehicle = await db.scalar(select(func.count()).select_from(KgVehicle))
            n_insight = await db.scalar(select(func.count()).select_from(KgTechInsight))
            n_tech = await db.scalar(select(func.count()).select_from(KgCoreTech))
            n_planned = await db.scalar(select(func.count()).select_from(KgPlannedVehicle))
            n_rel = await db.scalar(select(func.count()).select_from(KgRelation))

            cat_rows = await db.execute(select(KgCoreTech.tech_category, func.count()).group_by(KgCoreTech.tech_category))
            by_category = {str(r[0] or ""): int(r[1]) for r in cat_rows.all() if r[0]}

            rel_rows = await db.execute(select(KgRelation.rel_type, func.count()).group_by(KgRelation.rel_type))
            by_rel = {str(r[0]): int(r[1]) for r in rel_rows.all()}

        return {
            "nodes": {
                "Brand": int(n_brand or 0),
                "Vehicle": int(n_vehicle or 0),
                "TechInsight": int(n_insight or 0),
                "CoreTech": int(n_tech or 0),
                "PlannedVehicle": int(n_planned or 0),
            },
            "relations_explicit": int(n_rel or 0),
            "core_tech_by_category": by_category,
            "relations_by_type": by_rel,
        }

    async def validate(self) -> dict[str, Any]:
        """检测孤立边、缺失品牌引用等。"""
        errors: list[str] = []
        async with async_session_maker() as db:
            brands = {r.brand_id for r in (await db.execute(select(KgBrand))).scalars().all()}
            vehicles = {r.vehicle_id for r in (await db.execute(select(KgVehicle))).scalars().all()}
            insights = {r.insight_id for r in (await db.execute(select(KgTechInsight))).scalars().all()}
            techs = {r.tech_id for r in (await db.execute(select(KgCoreTech))).scalars().all()}
            planned = {r.planned_id for r in (await db.execute(select(KgPlannedVehicle))).scalars().all()}

            for v in (await db.execute(select(KgVehicle))).scalars().all():
                if v.brand_id not in brands:
                    errors.append(f"Vehicle {v.vehicle_id} 引用缺失品牌 {v.brand_id}")

            for pv in (await db.execute(select(KgPlannedVehicle))).scalars().all():
                if pv.brand_id not in brands:
                    errors.append(f"PlannedVehicle {pv.planned_id} 引用缺失品牌 {pv.brand_id}")

            for ct in (await db.execute(select(KgCoreTech))).scalars().all():
                if ct.insight_id and ct.insight_id not in insights:
                    errors.append(f"CoreTech {ct.tech_id} insight_id 不存在 {ct.insight_id}")

            res_rels = (await db.execute(select(KgRelation))).scalars().all()
            pool = {
                "Brand": brands,
                "Vehicle": vehicles,
                "TechInsight": insights,
                "CoreTech": techs,
                "PlannedVehicle": planned,
            }
            for rel in res_rels:
                if rel.src_kind not in pool or rel.dst_kind not in pool:
                    errors.append(f"关系 {rel.id} 节点类型非法")
                    continue
                if rel.src_id not in pool[rel.src_kind]:
                    errors.append(
                        f"孤立边 {rel.rel_type}: 源 {rel.src_kind}:{rel.src_id} 不存在",
                    )
                if rel.dst_id not in pool[rel.dst_kind]:
                    errors.append(
                        f"孤立边 {rel.rel_type}: 目标 {rel.dst_kind}:{rel.dst_id} 不存在",
                    )

        return {"ok": len(errors) == 0, "errors": errors, "error_count": len(errors)}

    async def import_bundle(self, data: dict[str, Any]) -> dict[str, int]:
        """从 JSON bundle 幂等 upsert（对齐 CSV 行字典）。"""
        counts = Counter()
        async with async_session_maker() as db:
            for row in data.get("brands", []) or []:
                if not isinstance(row, dict) or not row.get("brand_id"):
                    continue
                await _upsert_row(db, KgBrand, "brand_id", row)
                counts["brands"] += 1

            for row in data.get("vehicles", []) or []:
                if not isinstance(row, dict) or not row.get("vehicle_id"):
                    continue
                await _upsert_row(db, KgVehicle, "vehicle_id", row)
                counts["vehicles"] += 1

            for row in data.get("tech_insights", []) or []:
                if not isinstance(row, dict) or not row.get("insight_id"):
                    continue
                await _upsert_row(db, KgTechInsight, "insight_id", row)
                counts["tech_insights"] += 1

            for row in data.get("planned_vehicles", []) or []:
                if not isinstance(row, dict) or not row.get("planned_id"):
                    continue
                await _upsert_row(db, KgPlannedVehicle, "planned_id", row)
                counts["planned_vehicles"] += 1

            for row in data.get("core_techs", []) or []:
                if not isinstance(row, dict) or not row.get("tech_id"):
                    continue
                await _upsert_row(db, KgCoreTech, "tech_id", row)
                counts["core_techs"] += 1

            for row in data.get("relations", []) or []:
                if not isinstance(row, dict):
                    continue
                rt = str(row.get("rel_type", "")).upper()
                sk = row.get("src_kind")
                dk = row.get("dst_kind")
                sid = row.get("src_id")
                did = row.get("dst_id")
                if rt not in REL_TYPES or sk not in NODE_KINDS or dk not in NODE_KINDS:
                    continue
                rid = str(row.get("id") or uuid.uuid4())
                existing = await db.get(KgRelation, rid)
                if not existing:
                    db.add(
                        KgRelation(
                            id=rid,
                            rel_type=rt,
                            src_kind=str(sk),
                            src_id=str(sid),
                            dst_kind=str(dk),
                            dst_id=str(did),
                        )
                    )
                counts["relations"] += 1

            await db.commit()

        logger.info("kg import_bundle counts=%s", dict(counts))
        return dict(counts)

    async def export_bundle(self) -> dict[str, Any]:
        async with async_session_maker() as db:

            def row_dict(obj: Any) -> dict[str, Any]:
                return {c.name: getattr(obj, c.name, None) for c in obj.__table__.columns}

            brands = [row_dict(x) for x in (await db.execute(select(KgBrand))).scalars().all()]
            vehicles = [row_dict(x) for x in (await db.execute(select(KgVehicle))).scalars().all()]
            insights = [row_dict(x) for x in (await db.execute(select(KgTechInsight))).scalars().all()]
            planned = [row_dict(x) for x in (await db.execute(select(KgPlannedVehicle))).scalars().all()]
            techs = [row_dict(x) for x in (await db.execute(select(KgCoreTech))).scalars().all()]
            rels = [row_dict(x) for x in (await db.execute(select(KgRelation))).scalars().all()]

        return {
            "brands": brands,
            "vehicles": vehicles,
            "tech_insights": insights,
            "planned_vehicles": planned,
            "core_techs": techs,
            "relations": rels,
        }

    async def list_nodes(self, kind: str, limit: int = 200, offset: int = 0) -> list[dict[str, Any]]:
        if kind not in _MODEL_BY_KIND:
            return []
        model = _MODEL_BY_KIND[kind]
        async with async_session_maker() as db:
            q = select(model).limit(min(limit, 500)).offset(offset)
            rows = (await db.execute(q)).scalars().all()
            return [{c.name: getattr(r, c.name, None) for c in r.__table__.columns} for r in rows]

    async def get_node(self, kind: str, node_id: str) -> dict[str, Any] | None:
        if kind not in _MODEL_BY_KIND:
            return None
        model = _MODEL_BY_KIND[kind]
        id_field = _ID_FIELD[kind]
        async with async_session_maker() as db:
            q = select(model).where(getattr(model, id_field) == node_id)
            row = (await db.execute(q)).scalar_one_or_none()
            if not row:
                return None
            return {c.name: getattr(row, c.name, None) for c in row.__table__.columns}

    async def upsert_node(self, kind: str, data: dict[str, Any]) -> dict[str, Any]:
        if kind not in _MODEL_BY_KIND:
            raise ValueError("unknown kind")
        model = _MODEL_BY_KIND[kind]
        id_field = _ID_FIELD[kind]
        nid = data.get(id_field)
        if not nid:
            raise ValueError(f"missing {id_field}")
        nid = str(nid)
        keys = [c.name for c in model.__table__.columns]
        payload = {k: data.get(k) for k in keys if k in data or k == id_field}
        async with async_session_maker() as db:
            existing = await db.get(model, nid)
            if existing:
                for k, v in payload.items():
                    if k != id_field and hasattr(existing, k):
                        setattr(existing, k, v)
            else:
                ent = model(**{k: payload.get(k) for k in keys})
                db.add(ent)
            await db.commit()
        return await self.get_node(kind, nid) or {}

    async def delete_node(self, kind: str, node_id: str) -> bool:
        if kind not in _MODEL_BY_KIND:
            return False
        model = _MODEL_BY_KIND[kind]
        id_field = _ID_FIELD[kind]
        async with async_session_maker() as db:
            row = await db.get(model, node_id)
            if row:
                await db.delete(row)
                await db.execute(
                    delete(KgRelation).where(
                        or_(
                            (KgRelation.src_kind == kind) & (KgRelation.src_id == node_id),
                            (KgRelation.dst_kind == kind) & (KgRelation.dst_id == node_id),
                        )
                    )
                )
                await db.commit()
                return True
        return False

    async def add_relation(
        self,
        rel_type: str,
        src_kind: str,
        src_id: str,
        dst_kind: str,
        dst_id: str,
    ) -> dict[str, Any]:
        rel_type = rel_type.upper()
        if rel_type not in REL_TYPES:
            raise ValueError("bad rel_type")
        if src_kind not in NODE_KINDS or dst_kind not in NODE_KINDS:
            raise ValueError("bad node kind")
        rid = str(uuid.uuid4())
        async with async_session_maker() as db:
            db.add(
                KgRelation(
                    id=rid,
                    rel_type=rel_type,
                    src_kind=src_kind,
                    src_id=src_id,
                    dst_kind=dst_kind,
                    dst_id=dst_id,
                )
            )
            try:
                await db.commit()
            except IntegrityError:
                await db.rollback()
                raise
        return {
            "id": rid,
            "rel_type": rel_type,
            "src_kind": src_kind,
            "src_id": src_id,
            "dst_kind": dst_kind,
            "dst_id": dst_id,
        }

    async def delete_relation(self, rel_id: str) -> bool:
        async with async_session_maker() as db:
            row = await db.get(KgRelation, rel_id)
            if row:
                await db.delete(row)
                await db.commit()
                return True
        return False

    async def list_relations(
        self,
        rel_type: str | None = None,
        limit: int = 200,
    ) -> list[dict[str, Any]]:
        async with async_session_maker() as db:
            q = select(KgRelation).limit(min(limit, 500))
            if rel_type:
                q = q.where(KgRelation.rel_type == rel_type.upper())
            rows = (await db.execute(q)).scalars().all()
            return [{c.name: getattr(r, c.name, None) for c in r.__table__.columns} for r in rows]


class KbKgLinkService:
    async def list_for_entry(self, kb_entry_id: str, kb_project_id: str) -> list[dict[str, Any]]:
        async with async_session_maker() as db:
            q = select(KbKgLink).where(
                KbKgLink.kb_entry_id == kb_entry_id,
                KbKgLink.kb_project_id == kb_project_id,
            )
            rows = (await db.execute(q)).scalars().all()
            return [
                {c.name: getattr(r, c.name, None) for c in r.__table__.columns}
                for r in rows
            ]

    async def list_for_entry_all_projects(self, kb_entry_id: str) -> list[dict[str, Any]]:
        """同一 cache 条目 id 可能存在于多 project 或 __all__ 下，检索结果无 project 时合并全部关联。"""
        async with async_session_maker() as db:
            q = select(KbKgLink).where(KbKgLink.kb_entry_id == kb_entry_id)
            rows = (await db.execute(q)).scalars().all()
            return [
                {c.name: getattr(r, c.name, None) for c in r.__table__.columns}
                for r in rows
            ]

    async def add_link(
        self,
        kb_entry_id: str,
        kb_project_id: str,
        kg_kind: str,
        kg_node_id: str,
    ) -> dict[str, Any]:
        if kg_kind not in NODE_KINDS:
            raise ValueError("invalid kg_kind")
        lid = str(uuid.uuid4())
        row = KbKgLink(
            id=lid,
            kb_entry_id=kb_entry_id,
            kb_project_id=kb_project_id,
            kg_kind=kg_kind,
            kg_node_id=kg_node_id,
            created_at=_now(),
        )
        async with async_session_maker() as db:
            db.add(row)
            try:
                await db.commit()
            except IntegrityError:
                await db.rollback()
                raise
        return {c.name: getattr(row, c.name, None) for c in row.__table__.columns}

    async def delete_link(self, link_id: str) -> bool:
        async with async_session_maker() as db:
            row = await db.get(KbKgLink, link_id)
            if row:
                await db.delete(row)
                await db.commit()
                return True
        return False


kg_store_service = KgStoreService()
kb_kg_link_service = KbKgLinkService()
