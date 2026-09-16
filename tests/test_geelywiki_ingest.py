"""GeelyWiki LLMwiki 归档切块、claims 与图谱抽取。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.services.geelywiki_ingest import (
    ingest_geelywiki,
    load_pages_json,
    pages_to_documents,
    pages_to_kg_bundle,
)
from backend.services.kb_contract import (
    AUTHORITY_CANONICAL,
    GEELYWIKI_PAGES_COLLECTION,
)
from backend.services.kb_graph_pipeline import RELATED_TO

FIXTURE = Path(__file__).parent / "fixtures" / "kb" / "geelywiki_pages.json"


def test_fixture_xingyao_has_full_body_and_historical_claim():
    payload = load_pages_json(FIXTURE)
    assert payload["publish_scope"] == "internal"
    model = next(p for p in payload["pages"] if p["slug"] == "model-galaxy-xingyao-7")
    assert len(model["body"]) > 80
    claim = next(c for c in model["claims"] if c["id"] == "promo-price")
    assert claim["usage"] == "historical"
    assert claim["evidence_kind"] == "compiled_internal"


def test_pages_to_documents_splits_claims(tmp_path: Path):
    pages = load_pages_json(FIXTURE)["pages"]
    docs = pages_to_documents(pages, tmp_path / "staging")
    ids = {d["doc_id"] for d in docs}
    assert "wiki_model-galaxy-xingyao-7" in ids
    claim = next(d for d in docs if d.get("claim_id") == "promo-price")
    assert claim["usage"] == "historical"
    assert claim["source"] == "geelywiki"
    assert claim["authority"] == AUTHORITY_CANONICAL
    text = Path(claim["file_path"]).read_text(encoding="utf-8")
    assert "historical" in text
    assert "限时价" in text


def test_pages_to_kg_bundle_equipped_not_related():
    pages = load_pages_json(FIXTURE)["pages"]
    bundle = pages_to_kg_bundle(pages)
    rels = bundle["relations"]
    contains = [r for r in rels if r["rel_type"] == "CONTAINS_TECH"]
    related = [r for r in rels if r["rel_type"] == RELATED_TO]
    assert contains
    assert all(r["authority"] == AUTHORITY_CANONICAL for r in contains)
    assert all(r["evidence_kind"] == "equipped_with" for r in contains)
    assert related
    assert all(r["evidence_kind"] == "related_to" for r in related)
    assert any("qianli-haohan" in r["dst_id"] for r in contains)
    assert any("raytheon-em" in r["dst_id"] for r in related)


def test_ingest_geelywiki_dry_run_snapshots(tmp_path: Path):
    report = ingest_geelywiki(
        pages_json=FIXTURE,
        archive_root=tmp_path / "archive",
        apply=False,
    )
    assert report["ok"] is True
    assert report["apply"] is False
    assert report["claim_docs"] >= 1
    snap = Path(report["snapshot"])
    assert (snap / "pages.json").is_file()
    copied = json.loads((snap / "pages.json").read_text(encoding="utf-8"))
    assert copied["pages"][0]["body"]
    ingest = report["ingest"]
    assert ingest["dry_run"] is True
    assert ingest["collection"] == GEELYWIKI_PAGES_COLLECTION
    assert ingest["doc_succeeded"] >= 2


@pytest.mark.asyncio
async def test_apply_geelywiki_graph_writes_canonical_edge():
    from fastapi.testclient import TestClient

    from backend import app
    from backend.models.kg_entities import KgRelation
    from backend.services.geelywiki_ingest import apply_geelywiki_graph
    from backend.db import async_session_maker
    from sqlalchemy import select

    with TestClient(app):
        bundle = pages_to_kg_bundle(load_pages_json(FIXTURE)["pages"])
        counts = await apply_geelywiki_graph(bundle)
        assert counts["vehicles"] >= 1
        assert counts["relations"] >= 1
        async with async_session_maker() as db:
            rows = (await db.execute(select(KgRelation).where(KgRelation.rel_type == "CONTAINS_TECH"))).scalars().all()
        canonical = [r for r in rows if r.authority == AUTHORITY_CANONICAL]
        assert canonical
        assert all((r.evidence_kind or "") == "equipped_with" for r in canonical)
