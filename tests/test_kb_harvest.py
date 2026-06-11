"""知识收割：策略拒绝、Chroma 只读降级、去重与成功写入（mock ingest）。"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from backend.services.kb_write import (
    add_kb_harvest_entry,
    compute_doc_id_from_content,
    compute_dedupe_key,
)


@pytest.fixture
def harvest_params():
    return {
        "collection_name": "internal.test.collection",
        "project_id": "42",
        "title": "API 超时重试策略",
        "content": "## 规则\n\n重试最多 3 次，间隔指数退避。",
        "summary": None,
        "tags": ["ops"],
        "domain": "internal_methodology",
        "source": "hermes_chat",
        "published": False,
        "metadata": {"conversation_id": "c1", "harvested_from_user_confirmed": True},
        "scenario_id": None,
        "chroma_url": "http://chromatest:8001",
        "strict_domain": False,
    }


@pytest.mark.asyncio
async def test_harvest_collection_policy_reject(monkeypatch, harvest_params):
    monkeypatch.setenv("KNOWLEDGE_HARVEST_WRITE_ALLOWED_COLLECTIONS", "other.only")
    out = await add_kb_harvest_entry(**harvest_params)
    assert out["ok"] is False
    assert out.get("message") == "collection_not_allowed"
    assert "internal.test.collection" not in (out.get("allowed_collections") or [])


@pytest.mark.asyncio
async def test_harvest_chroma_readonly(harvest_params):
    with patch("backend.services.kb_write.ChromaHttpClient") as CC:
        cli = MagicMock()
        cli.heartbeat.return_value = False
        cli.get_by_where = MagicMock()
        CC.return_value = cli

        out = await add_kb_harvest_entry(**harvest_params)
        assert out["ok"] is False
        assert out.get("readonly") is True
        assert out.get("message") == "kb_unavailable"


@pytest.mark.asyncio
async def test_harvest_duplicate(harvest_params):
    with patch("backend.services.kb_write.ChromaHttpClient") as CC:
        cli = MagicMock()
        cli.heartbeat.return_value = True
        cli.get_by_where.return_value = {
            "ids": [["harvest_deadbeef_chunk_0001"]],
            "metadatas": [[{"doc_id": "harvest_deadbeef"}]],
        }
        CC.return_value = cli

        out = await add_kb_harvest_entry(**harvest_params)
        assert out["ok"] is False
        assert out.get("reason") == "duplicate"
        assert out.get("existing_doc_id")


@pytest.mark.asyncio
async def test_harvest_success_writes_and_syncs(harvest_params, tmp_path, monkeypatch):
    monkeypatch.setenv("KB_UPLOAD_DIR", str(tmp_path))

    ingest_report = {
        "doc_succeeded": 1,
        "chunk_upserted": 2,
        "collection": harvest_params["collection_name"],
        "job_id": "j1",
        "errors": [],
    }

    async def fake_sync(**kwargs):
        return 2

    with patch("backend.services.kb_write.ChromaHttpClient") as CC:
        cli = MagicMock()
        cli.heartbeat.return_value = True

        # 第一次 dedupe：无命中
        def _gw(*args, **kwargs):
            return {"ids": [], "metadatas": []}

        cli.get_by_where.side_effect = _gw
        CC.return_value = cli

        with patch("backend.services.kb_write.run_kb_ingestion", return_value=ingest_report):
            with patch(
                "backend.services.kb_write.sync_harvest_doc_to_cache",
                side_effect=fake_sync,
            ) as sync_m:
                out = await add_kb_harvest_entry(**harvest_params)
                assert out["ok"] is True
                assert out["doc_id"] == compute_doc_id_from_content(harvest_params["content"])
                assert out["chunk_count"] == 2
                sync_m.assert_called_once()


def test_dedupe_key_stable():
    t = "T"
    b = "body\nmore"
    k1 = compute_dedupe_key(t, b)
    k2 = compute_dedupe_key(t + " ", b + "\n")
    assert k1 == k2
    assert k1 == compute_dedupe_key(t.strip(), b.strip())


def test_doc_id_depends_only_on_body():
    a = compute_doc_id_from_content("same")
    b = compute_doc_id_from_content("same")
    c = compute_doc_id_from_content("other")
    assert a == b
    assert a != c
