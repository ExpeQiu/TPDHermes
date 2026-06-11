"""项目 KB 统一入库与 RAG 消费回归测试。"""

from __future__ import annotations

import uuid
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from backend import app
from backend.services.document_extract import DocumentExtractError, extract_to_markdown
from backend.services.project_kb import (
    merge_project_kb_collections,
    output_published_for_status,
    project_kb_collection,
)
from backend.tools.kb_tools import _filter_project_kb_results


def test_project_kb_collection_name():
    pid = "aa698784-27a7-407a-97ec-a016fe43f5b9"
    assert project_kb_collection(pid) == f"project.{pid}.kb"


def test_merge_project_kb_collections():
    pid = str(uuid.uuid4())
    col = project_kb_collection(pid)
    merged = merge_project_kb_collections(["tpd_docs"], pid)
    assert merged[0] == col
    assert "tpd_docs" in merged


def test_output_published_for_status():
    assert output_published_for_status("draft") is False
    assert output_published_for_status("archived") is False
    assert output_published_for_status("completed") is True
    assert output_published_for_status("approved") is True


def test_kb_query_filters_unpublished_project_chunks():
    col = project_kb_collection("p1")
    raw = {
        "results": [
            {"content": "a", "metadata": {"published": True}, "distance": 0.1},
            {"content": "b", "metadata": {"published": False}, "distance": 0.2},
        ],
        "count": 2,
        "source": "chroma",
    }
    out = _filter_project_kb_results(raw, col)
    assert out["count"] == 1
    assert out["results"][0]["content"] == "a"


def test_extract_plain_text(tmp_path: Path):
    p = tmp_path / "note.md"
    p.write_text("# Hello\n\nworld", encoding="utf-8")
    text = extract_to_markdown(p)
    assert "Hello" in text and "world" in text


def test_extract_unsupported(tmp_path: Path):
    p = tmp_path / "data.bin"
    p.write_bytes(b"\x00\x01")
    with pytest.raises(DocumentExtractError):
        extract_to_markdown(p)


def test_project_context_includes_kb_stats():
    with TestClient(app) as client:
        pr = client.post("/api/v1/projects/", json={"name": "KB上下文项目"}).json()
        pid = pr["id"]
        r = client.get(f"/api/v1/projects/{pid}/context")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["kb_stats"] is not None
    assert data["kb_stats"]["collection"] == project_kb_collection(pid)
    assert "attachments_indexed" in data["kb_stats"]


def test_orchestration_preview_includes_project_kb_collection():
    with TestClient(app) as client:
        pr = client.post("/api/v1/projects/", json={"name": "KB编排项目"}).json()
        pid = pr["id"]
        r = client.post(
            f"/api/v1/projects/{pid}/orchestration/preview",
            json={"user_message": "测试", "scenario_id": "general"},
        )
    assert r.status_code == 200, r.text
    cols = (r.json().get("payload") or {}).get("knowledge", {}).get("collections") or []
    assert project_kb_collection(pid) in cols


@patch("backend.services.project_kb_ingest.run_kb_ingestion")
@patch("backend.services.project_kb_ingest.ChromaHttpClient")
def test_ingest_attachment_txt(mock_client_cls, mock_ingest, tmp_path: Path):
    from backend.services.project_kb_ingest import ingest_project_attachment

    mock_client = MagicMock()
    mock_client.heartbeat.return_value = True
    mock_client_cls.return_value = mock_client
    mock_ingest.return_value = {"doc_succeeded": 1, "chunk_upserted": 2, "errors": []}

    with TestClient(app) as client:
        pr = client.post("/api/v1/projects/", json={"name": "附件KB项目"}).json()
        pid = pr["id"]
        files = {"file": ("readme.txt", b"hello attachment content for kb", "text/plain")}
        up = client.post(f"/api/v1/projects/{pid}/attachments", files=files)
        assert up.status_code == 200, up.text
        aid = up.json()["id"]

    import asyncio

    with patch("backend.services.project_kb_ingest.kb_cache_service") as mock_cache:
        mock_cache.sync_selection_from_external = MagicMock(
            return_value={"synced": 1, "incremental": True}
        )
        result = asyncio.run(ingest_project_attachment(aid))
    assert result.ok, result.message
    assert result.doc_id == f"att_{aid}"
    assert result.chunk_count == 2


@patch("backend.services.project_kb_ingest.run_kb_ingestion")
@patch("backend.services.project_kb_ingest.ChromaHttpClient")
def test_draft_output_ingest_unpublished(mock_client_cls, mock_ingest):
    from backend.services.project_kb_ingest import _ingest_markdown_sync

    mock_client = MagicMock()
    mock_client.heartbeat.return_value = True
    mock_client_cls.return_value = mock_client
    mock_ingest.return_value = {"doc_succeeded": 1, "chunk_upserted": 1, "errors": []}

    pid = str(uuid.uuid4())
    doc_id = "out_test"
    result, _, _ = _ingest_markdown_sync(
        project_id=pid,
        doc_id=doc_id,
        title="Draft",
        markdown_body="draft body content here",
        folder_path="outputs",
        source_type="project_output",
        source_id="out1",
        published=False,
        output_status="draft",
    )
    assert result.ok
    call_args = mock_ingest.call_args
    manifest = call_args.kwargs.get("manifest") or call_args[1].get("manifest")
    assert manifest["defaults"]["published"] is False
