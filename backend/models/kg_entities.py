"""
知识图谱实体与关系（对齐离线 kg_data CSV / Neo4j 约束）。

OWNS、PLANNED_BY 可由 Vehicle.brand_id、PlannedVehicle.brand_id 推导；
HAS_INSIGHT、CONTAINS_TECH 使用 KgRelation 显式存储。
"""

from sqlalchemy import Column, String, Text, UniqueConstraint

from backend.db import Base


class KgBrand(Base):
    __tablename__ = "kg_brand"

    brand_id = Column(String, primary_key=True)
    name_cn = Column(String)
    domain = Column(String)
    source = Column(String)
    primary_kb_entry_id = Column(String, nullable=True)
    primary_kb_project_id = Column(String, nullable=True)


class KgVehicle(Base):
    __tablename__ = "kg_vehicle"

    vehicle_id = Column(String, primary_key=True)
    brand_id = Column(String, nullable=False, index=True)
    name = Column(String)
    vehicle_type = Column(String)
    price_range = Column(String)
    power_type = Column(String)
    core_highlights = Column(Text)
    source = Column(String)
    primary_kb_entry_id = Column(String, nullable=True)
    primary_kb_project_id = Column(String, nullable=True)


class KgTechInsight(Base):
    __tablename__ = "kg_tech_insight"

    insight_id = Column(String, primary_key=True)
    brand_id = Column(String, index=True)
    vehicle_name = Column(String)
    s_level = Column(Text)
    a_level = Column(Text)
    b_level = Column(Text)
    release_type = Column(String)
    release_date = Column(String)
    analysis_status = Column(String)
    narrative_pain = Column(Text)
    narrative_theme = Column(Text)
    narrative_opening = Column(Text)
    media_channel = Column(String)
    media_rhythm = Column(String)
    quote = Column(Text)
    tech_platform = Column(Text)
    tech_chassis = Column(Text)
    tech_cabin = Column(Text)
    tech_ad = Column(Text)
    tech_battery = Column(Text)
    source_link = Column(String)
    analyst = Column(String)
    source = Column(String)
    primary_kb_entry_id = Column(String, nullable=True)
    primary_kb_project_id = Column(String, nullable=True)


class KgPlannedVehicle(Base):
    __tablename__ = "kg_planned_vehicle"

    planned_id = Column(String, primary_key=True)
    brand_id = Column(String, nullable=False, index=True)
    vehicle_name = Column(String)
    planned_release_date = Column(String)
    analysis_status = Column(String)
    release_type = Column(String)
    analyst = Column(String)
    source = Column(String)
    primary_kb_entry_id = Column(String, nullable=True)
    primary_kb_project_id = Column(String, nullable=True)


class KgCoreTech(Base):
    __tablename__ = "kg_core_tech"

    tech_id = Column(String, primary_key=True)
    brand_id = Column(String, index=True)
    vehicle_name = Column(String)
    insight_id = Column(String, index=True)
    tech_category = Column(String, index=True)
    ai_category = Column(String)
    tech_text = Column(Text)
    source = Column(String)
    primary_kb_entry_id = Column(String, nullable=True)
    primary_kb_project_id = Column(String, nullable=True)


class KgRelation(Base):
    __tablename__ = "kg_relation"
    __table_args__ = (
        UniqueConstraint(
            "rel_type",
            "src_kind",
            "src_id",
            "dst_kind",
            "dst_id",
            name="uq_kg_relation_edge",
        ),
    )

    id = Column(String, primary_key=True)
    rel_type = Column(String, nullable=False, index=True)
    src_kind = Column(String, nullable=False, index=True)
    src_id = Column(String, nullable=False, index=True)
    dst_kind = Column(String, nullable=False, index=True)
    dst_id = Column(String, nullable=False, index=True)
