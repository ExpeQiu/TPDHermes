"""外部情报向量后图谱：弱权威，不得覆盖 Wiki 搭载。"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from backend import app
from backend.db import async_session_maker
from backend.models.kg_entities import KgRelation
from backend.services.geelywiki_ingest import load_pages_json, pages_to_kg_bundle
from backend.services.geelywiki_ingest import apply_geelywiki_graph
from backend.services.kb_contract import (
    AUTHORITY_CANONICAL,
    AUTHORITY_SUPPLEMENT,
    PUBLIC_INTEL_STRATEGY_COLLECTION,
    PUBLIC_INTEL_TECH_COLLECTION,
    PUBLIC_INTEL_VEHICLE_COLLECTION,
)
from backend.services.kb_graph_pipeline import upsert_relation_with_authority
from backend.services.public_intel_ingest import document_to_intel_bundle, graph_after_public_ingest

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "kb"
WIKI_PAGES = FIXTURE_DIR / "geelywiki_pages.json"


def test_strategy_vehicle_tech_bundles_are_supplement_not_contains_tech():
    strategy = (FIXTURE_DIR / "public_intel" / "strategy.md").read_text(encoding="utf-8")
    vehicle = (FIXTURE_DIR / "public_intel" / "vehicle.md").read_text(encoding="utf-8")
    tech = (FIXTURE_DIR / "public_intel" / "tech.md").read_text(encoding="utf-8")
    s = document_to_intel_bundle(
        collection=PUBLIC_INTEL_STRATEGY_COLLECTION,
        doc_id="strategy1",
        title="比亚迪 2026 战略摘录",
        body=strategy,
        meta={},
    )
    v = document_to_intel_bundle(
        collection=PUBLIC_INTEL_VEHICLE_COLLECTION,
        doc_id="veh1",
        title="小米 SU7",
        body=vehicle,
        meta={},
    )
    t = document_to_intel_bundle(
        collection=PUBLIC_INTEL_TECH_COLLECTION,
        doc_id="tech1",
        title="宁德时代麒麟电池报道",
        body=tech,
        meta={},
    )
    assert s["tech_insights"]
    assert all(r["authority"] == AUTHORITY_SUPPLEMENT for r in s["relations"])
    assert v["vehicles"]
    assert all(r["rel_type"] != "CONTAINS_TECH" for r in v["relations"])
    assert all(str(x["vehicle_id"]).startswith("intel_vehicle_") for x in v["vehicles"])
    assert t["core_techs"]
    assert all(r["rel_type"] != "CONTAINS_TECH" for r in t["relations"])
    assert all(r["evidence_kind"] in {"web", "third_party"} for r in t["relations"] + s["relations"] + v["relations"])


@pytest.mark.asyncio
async def test_public_ingest_graph_and_does_not_overwrite_wiki_equipped():
    with TestClient(app):
        wiki = pages_to_kg_bundle(load_pages_json(WIKI_PAGES)["pages"])
        await apply_geelywiki_graph(wiki)
        contains = [r for r in wiki["relations"] if r["rel_type"] == "CONTAINS_TECH"][0]
        weak = await upsert_relation_with_authority(
            rel_type="CONTAINS_TECH",
            src_kind=contains["src_kind"],
            src_id=contains["src_id"],
            dst_kind=contains["dst_kind"],
            dst_id=contains["dst_id"],
            source="public_intel",
            authority=AUTHORITY_SUPPLEMENT,
            source_collection=PUBLIC_INTEL_TECH_COLLECTION,
            evidence_kind="web",
        )
        assert weak.get("skipped") is True
        async with async_session_maker() as db:
            rows = (
                await db.execute(
                    select(KgRelation).where(
                        KgRelation.rel_type == "CONTAINS_TECH",
                        KgRelation.src_id == contains["src_id"],
                        KgRelation.dst_id == contains["dst_id"],
                    )
                )
            ).scalars().all()
        assert rows
        assert all(r.authority == AUTHORITY_CANONICAL for r in rows)

        veh_md = FIXTURE_DIR / "public_intel" / "vehicle.md"
        manifest = {
            "documents": [
                {
                    "doc_id": "intel_su7",
                    "file_path": str(veh_md),
                    "title": "小米 SU7",
                    "brand": "小米",
                }
            ]
        }
        report = await graph_after_public_ingest(PUBLIC_INTEL_VEHICLE_COLLECTION, manifest)
        assert report.get("ok") is True
        assert report["counts"].get("vehicles", 0) >= 1
