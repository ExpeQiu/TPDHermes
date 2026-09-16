"""经 GeelyWiki CLI 拉取知识更新。"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.services.geelywiki_cli import GeelyWikiCliError, fetch_pages_via_cli, run_geelywiki_cli
from backend.services.geelywiki_ingest import ingest_geelywiki
from backend.services.kb_contract import GEELYWIKI_PAGES_COLLECTION

EXPORT = {
    "module": "pages-export",
    "data_source": "demo",
    "fetched_at": "2026-09-16T00:00:00Z",
    "publish_scope": "internal",
    "pages": [
        {
            "slug": "demo-xingyao",
            "title": "演示 · 银河星耀7 MAX",
            "type": "model",
            "domain": "brand_map",
            "related": ["demo-charter"],
            "equipped_with": [{"slug": "demo-charter", "role": "related-doc"}],
            "related_to": [{"slug": "demo-charter", "role": "charter"}],
            "claims": [
                {
                    "id": "demo-price",
                    "statement": "演示限时价",
                    "usage": "historical",
                    "evidence_kind": "compiled_internal",
                }
            ],
            "body": "# 演示星耀\n\n正文不少于二十个汉字以便切块入库。\n",
        }
    ],
}


def test_fetch_pages_via_cli_uses_export(monkeypatch):
    monkeypatch.setattr(
        "backend.services.geelywiki_cli.run_geelywiki_cli",
        lambda args, **kwargs: EXPORT,
    )
    payload = fetch_pages_via_cli(demo=True)
    assert payload["data_source"] == "demo"
    assert payload["pages"][0]["body"]
    assert payload["pages"][0]["claims"][0]["usage"] == "historical"


def test_fetch_pages_via_cli_falls_back_to_list_get(monkeypatch):
    def fake_run(args, **kwargs):
        if args[:2] == ["pages", "export"]:
            raise GeelyWikiCliError("no export")
        if args[:2] == ["pages", "list"]:
            return {"module": "pages-list", "data_source": "demo", "items": [{"slug": "demo-xingyao"}]}
        if args[:2] == ["pages", "get"]:
            return {"module": "pages-get", "item": EXPORT["pages"][0]}
        raise AssertionError(args)

    monkeypatch.setattr("backend.services.geelywiki_cli.run_geelywiki_cli", fake_run)
    payload = fetch_pages_via_cli(demo=True)
    assert len(payload["pages"]) == 1
    assert payload["pages"][0]["slug"] == "demo-xingyao"


def test_ingest_from_cli_demo_dry_run(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(
        "backend.services.geelywiki_cli.run_geelywiki_cli",
        lambda args, **kwargs: EXPORT,
    )
    report = ingest_geelywiki(
        archive_root=tmp_path / "archive",
        apply=False,
        from_cli=True,
        demo=True,
    )
    assert report["ok"] is True
    assert str(report["source"]).startswith("cli:")
    assert report["ingest"]["collection"] == GEELYWIKI_PAGES_COLLECTION
    assert report["claim_docs"] >= 1
    snap = Path(report["snapshot"]) / "pages.json"
    assert snap.is_file()
    assert "demo-xingyao" in snap.read_text(encoding="utf-8")


@pytest.mark.skipif(
    not Path("/Volumes/Lexar/git/03T/GeelyWiki/bin/geelywiki.mjs").is_file(),
    reason="GeelyWiki CLI 不在本机",
)
def test_live_demo_export_has_body_and_claims():
    payload = run_geelywiki_cli(["pages", "export"], demo=True)
    assert payload.get("module") == "pages-export"
    pages = payload.get("pages") or []
    xing = next(p for p in pages if p.get("slug") == "demo-xingyao")
    assert xing.get("body")
    assert any(c.get("id") == "demo-price" and c.get("usage") == "historical" for c in xing.get("claims") or [])
    assert xing.get("equipped_with")
