"""KB 导入链路：metadata 还原、doc_id、旧 chunk 清理。"""

import uuid
from datetime import datetime
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from backend import app
from backend.db import async_session_maker
from backend.models.kb_cache import KBCache
from backend.models.kb_source_file import KbSourceFile
from backend.services.kb_cache import kb_cache_service
from backend.services.kb_ingest_core import (
    build_manifest_from_uploads,
    delete_stale_chunks_for_doc,
    run_kb_ingestion,
)
from backend.services.kb_metadata import normalize_kb_metadata_dict


def test_normalize_metadata_json_arrays():
    meta = {
        "title": "t",
        "tags": '["a", "b"]',
        "linked_kg_ids": '["K:1"]',
        "project_ids": "[7, 9]",
        "published": "true",
    }
    out = normalize_kb_metadata_dict(meta)
    assert out["tags"] == ["a", "b"]
    assert out["linked_kg_ids"] == ["K:1"]
    assert out["project_ids"] == [7, 9]
    assert out["published"] is True


def test_build_manifest_uses_original_filename_stem():
    items = [
        {
            "stored_path": "/tmp/uuid_README.md",
            "file_name": "README.md",
            "checksum": "sha256:abcd",
        }
    ]
    m = build_manifest_from_uploads("b", "col", {}, items)
    assert m["documents"][0]["doc_id"] == "README"


def test_build_manifest_explicit_beats_checksum_strategy():
    items = [
        {
            "stored_path": "/x",
            "file_name": "README.md",
            "doc_id": "stable_doc",
            "checksum": "sha256:" + "a" * 64,
        }
    ]
    m = build_manifest_from_uploads("b", "col", {"doc_id_strategy": "checksum"}, items)
    assert m["documents"][0]["doc_id"] == "stable_doc"


def test_build_manifest_checksum_strategy():
    hx = "a" * 64
    items = [
        {
            "stored_path": "/x",
            "file_name": "README.md",
            "checksum": "sha256:" + hx,
        }
    ]
    m = build_manifest_from_uploads("b", "col", {"doc_id_strategy": "checksum"}, items)
    assert m["documents"][0]["doc_id"] == "doc_" + hx[:16]


def test_delete_stale_chunks_removes_extra():
    client = MagicMock()
    client.get_by_where.return_value = {
        "ids": ["d_chunk_0001", "d_chunk_0002", "d_chunk_0003"],
    }
    n = delete_stale_chunks_for_doc(client, "c", "d", {"d_chunk_0001"})
    assert n == 2
    client.delete.assert_called_once()
    _col, del_ids = client.delete.call_args[0]
    assert _col == "c"
    assert set(del_ids) == {"d_chunk_0002", "d_chunk_0003"}


@patch("backend.services.kb_ingest_core.embed_on_upsert_enabled", return_value=False)
@patch("backend.services.kb_ingest_core.ChromaHttpClient")
def test_run_kb_ingestion_deletes_stale_after_upsert(
    MockClient, _embed_off, tmp_path: Path
):
    p = tmp_path / "a.md"
    p.write_text("# hi\n", encoding="utf-8")
    cli = MagicMock()
    MockClient.return_value = cli
    cli.heartbeat.return_value = True
    cli.get_by_where.return_value = {"ids": ["x_chunk_0001", "x_chunk_0002"]}
    manifest = {
        "batch_id": "b",
        "collection": "col",
        "defaults": {
            "domain": "structured_tech",
            "folder_path": "p",
            "source": "s",
        },
        "documents": [{"doc_id": "x", "file_path": str(p)}],
    }
    rep = run_kb_ingestion(
        manifest=manifest,
        collection="col",
        chroma_url="http://c",
        job_id="j1",
        dry_run=False,
    )
    assert rep["doc_succeeded"] == 1
    assert rep.get("chunks_deleted_stale", 0) >= 1
    cli.upsert.assert_called()
    cli.delete.assert_called()


@pytest.mark.asyncio
async def test_get_cached_entry_normalizes_stringified_project_ids():
    await kb_cache_service.ensure_table()
    rid = f"unit-{uuid.uuid4()}"
    raw_meta = (
        '{"title":"T1","project_ids":"[7, 9]","tags":"[\\"x\\"]",'
        '"linked_kg_ids":"[\\"A:1\\"]"}'
    )
    async with async_session_maker() as db:
        db.add(
            KBCache(
                id=rid,
                project_id="__all__",
                collection="c",
                content="body",
                metadata_=raw_meta,
                source="t",
                created_at=datetime.now().isoformat(),
                updated_at=datetime.now().isoformat(),
                sync_status="synced",
                reliability=0.9,
                version=1,
            )
        )
        await db.commit()

    row = await kb_cache_service.get_cached_entry_by_id(rid)
    assert row is not None
    assert row["metadata"]["project_ids"] == [7, 9]
    assert row["metadata"]["tags"] == ["x"]
    assert row["metadata"]["linked_kg_ids"] == ["A:1"]


@pytest.mark.asyncio
async def test_kb_upload_persists_doc_id_hint(tmp_path, monkeypatch):
    monkeypatch.setenv("KB_UPLOAD_DIR", str(tmp_path / "up"))
    uid = str(uuid.uuid4())
    content = b"# t\n"
    with TestClient(app) as client:
        r = client.post(
            "/api/v1/kb/upload",
            files={"file": ("mydoc.md", content, "text/markdown")},
            data={"doc_id": "stable_doc_1"},
        )
    assert r.status_code == 200
    body = r.json()
    assert body.get("doc_id_hint") == "stable_doc_1"
    up_id = body["upload_id"]
    async with async_session_maker() as db:
        row = await db.get(KbSourceFile, up_id)
    assert row is not None
    assert row.doc_id_hint == "stable_doc_1"
    assert Path(row.stored_path).is_file()
