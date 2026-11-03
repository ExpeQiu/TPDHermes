"""知识库边界、身份、导入租约与离线检索合同。"""

import pytest

from backend.services.kb_access import assert_ingest_file
from backend.services.kb_ids import cache_row_id, catalog_index_doc_id
from backend.services.kb_lexical import lexical_score
from backend.services.project_kb import settle_docs_into_project_kb


def test_catalog_index_id_keeps_chinese_folders_apart():
    a = catalog_index_doc_id(
        scope="public",
        project_id="",
        collection="public.structured_tech.general",
        folder="资料/电池",
    )
    b = catalog_index_doc_id(
        scope="public",
        project_id="",
        collection="public.structured_tech.general",
        folder="资料/电机",
    )
    assert a != b
    assert a.startswith("pathcat_")


def test_cache_identity_is_scoped_by_project_and_collection():
    left = cache_row_id("p1", "col-a", "doc_chunk_0001")
    right = cache_row_id("p2", "col-a", "doc_chunk_0001")
    other = cache_row_id("p1", "col-b", "doc_chunk_0001")
    assert len({left, right, other}) == 3


def test_offline_lexical_empty_when_unrelated():
    assert lexical_score("电池热管理", "这是一份与问题无关的目录说明") == 0
    assert lexical_score("电池热管理", "电池热管理需要液冷") > 0


def test_ingest_path_rejects_outside_upload_root(tmp_path, monkeypatch):
    root = tmp_path / "uploads"
    root.mkdir()
    outside = tmp_path / "secret.txt"
    outside.write_text("secret", encoding="utf-8")
    monkeypatch.setenv("KB_UPLOAD_DIR", str(root))
    with pytest.raises(PermissionError):
        assert_ingest_file(str(outside))


def test_ingest_path_rejects_symlink(tmp_path, monkeypatch):
    root = tmp_path / "uploads"
    root.mkdir()
    target = root / "real.txt"
    target.write_text("ok", encoding="utf-8")
    link = root / "link.txt"
    link.symlink_to(target)
    monkeypatch.setenv("KB_UPLOAD_DIR", str(root))
    with pytest.raises(PermissionError):
        assert_ingest_file(str(link))


def test_ingest_path_accepts_file_inside_root(tmp_path, monkeypatch):
    root = tmp_path / "uploads"
    root.mkdir()
    inside = root / "note.md"
    inside.write_text("正文", encoding="utf-8")
    monkeypatch.setenv("KB_UPLOAD_DIR", str(root))
    assert assert_ingest_file(str(inside)) == inside.resolve()


@pytest.mark.asyncio
async def test_settle_into_project_kb_stays_deferred():
    result = await settle_docs_into_project_kb(doc_ids=["doc-1"], project_id="p1")
    assert result["ok"] is False
    assert result["message"] == "settle_contract_deferred"
    assert result["updated"] == 0


@pytest.mark.asyncio
async def test_two_workers_claim_ingest_job_once():
    from backend.services.kb_ingest_job_service import claim_ingest_job, create_ingest_job

    created = await create_ingest_job(
        normalized={
            "payload": {"source_type": "manifest"},
            "manifest": {"collection": "public.demo.general", "documents": []},
            "collection": "public.demo.general",
            "project_id": "__all__",
            "doc_ids": ["d1"],
        },
        created_by="owner",
    )
    job_id = created["job_id"]
    first = await claim_ingest_job(job_id, "worker-a")
    second = await claim_ingest_job(job_id, "worker-b")
    assert first is not None
    assert second is None
    assert first.worker_id == "worker-a"
    assert first.lease_until


def test_chroma_distance_zero_sorts_before_larger_distance():
    from backend.services.kb_chroma_query import parse_chroma_query_response

    parsed = parse_chroma_query_response(
        {
            "documents": [["较远", "最近"]],
            "metadatas": [[{}, {}]],
            "distances": [[0.4, 0.0]],
        },
        collection_name="col",
    )
    assert parsed[0]["content"] == "最近"
    assert parsed[0]["distance"] == 0.0
