"""kb_entry_manage 单元测试（mock Chroma）。"""

from unittest.mock import patch

import pytest

from backend.services.kb_entry_manage import (
    _update_kb_entry_sync,
    delete_cached_entries_by_doc_id,
    delete_kb_entry,
)


@pytest.mark.asyncio
async def test_delete_cached_entries_by_doc_id():
    from backend.db import async_session_maker
    from backend.models.kb_cache import KBCache

    async with async_session_maker() as db:
        db.add(
            KBCache(
                id="doc_a_chunk_0001",
                project_id="__all__",
                collection="public.test.col",
                content="hello",
                metadata_='{"doc_id":"doc_a"}',
                source="test",
                created_at="2026-01-01",
                updated_at="2026-01-01",
            )
        )
        await db.commit()

    n = await delete_cached_entries_by_doc_id("doc_a", collection="public.test.col")
    assert n >= 1


@patch("backend.services.kb_entry_manage.ChromaHttpClient")
def test_delete_collection_sync(MockClient):
    client = MockClient.return_value
    client.heartbeat.return_value = True
    client.list_all_ids.return_value = ["a_chunk_1", "b_chunk_2"]

    from backend.services.kb_entry_manage import _delete_collection_sync

    result = _delete_collection_sync(collection="public.test.col", chroma_url="http://chroma")
    assert result["ok"] is True
    assert result["removed_chunks"] == 2
    client.delete.assert_called_once()


@patch("backend.services.kb_entry_manage.ChromaHttpClient")
def test_update_metadata_only(MockClient):
    client = MockClient.return_value
    client.heartbeat.return_value = True
    client.get_by_where.return_value = {
        "ids": [["c1", "c2"]],
        "metadatas": [[
            {"doc_id": "d1", "title": "旧标题", "domain": "structured_tech", "folder_path": "a/b"},
            {"doc_id": "d1", "title": "旧标题", "domain": "structured_tech", "folder_path": "a/b"},
        ]],
        "documents": [["body1", "body2"]],
    }

    result = _update_kb_entry_sync(
        collection="public.structured_tech.topic",
        doc_id="d1",
        chroma_url="http://chroma",
        title="新标题",
        metadata={"folder_path": "a/c", "published": False},
    )
    assert result["ok"] is True
    assert result["updated"] == "metadata"
    assert client.update.call_count == 2


@pytest.mark.asyncio
@patch("backend.services.kb_entry_manage.delete_cached_entries_by_doc_id", return_value=2)
@patch("backend.services.kb_entry_manage.delete_doc_from_collection", return_value=0)
@patch("backend.services.kb_entry_manage.ChromaHttpClient")
async def test_delete_kb_entry_cache_only(MockClient, _mock_del_chroma, mock_del_cache):
    client = MockClient.return_value
    client.heartbeat.return_value = True

    result = await delete_kb_entry(
        collection="public.test.col",
        doc_id="orphan_doc",
        sync_cache=False,
    )
    assert result["ok"] is True
    assert result["removed_chunks"] == 0
    assert result["cache_removed"] == 2
    mock_del_cache.assert_awaited_once()
