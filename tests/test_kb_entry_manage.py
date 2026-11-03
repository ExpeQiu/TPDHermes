"""kb_entry_manage 单元测试（mock Chroma）。"""

from unittest.mock import patch

import pytest

from backend.services.kb_entry_manage import (
    _update_kb_entry_sync,
    delete_cached_entries_by_doc_id,
    delete_cached_entry_by_id,
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


@pytest.mark.asyncio
async def test_delete_cached_entry_by_id_chunk_ref():
    from backend.db import async_session_maker
    from backend.models.kb_cache import KBCache

    async with async_session_maker() as db:
        db.add(
            KBCache(
                id="harvest_deadbeef_chunk_0001",
                project_id="__all__",
                collection="internal.structured_tech.smoke",
                content="body",
                metadata_='{"doc_id":"harvest_deadbeef"}',
                source="harvest",
                created_at="2026-01-01",
                updated_at="2026-01-01",
            )
        )
        await db.commit()

    ok = await delete_cached_entry_by_id(
        "harvest_deadbeef_chunk_0099",
        collection="internal.structured_tech.smoke",
    )
    assert ok is True


@patch("backend.services.kb_entry_manage.delete_cached_entries_by_collection")
@patch("backend.services.kb_entry_manage.ChromaHttpClient")
@pytest.mark.asyncio
async def test_drop_kb_collection_purges_then_drops(MockClient, mock_cache):
    order: list[str] = []
    client = MockClient.return_value
    client.heartbeat.return_value = True
    client.collection_names.return_value = ["public.test.col"]
    client.list_all_ids.return_value = ["a_chunk_1", "b_chunk_2"]

    def _delete_chunks(*_args, **_kwargs):
        order.append("chunks")

    def _drop(_name):
        order.append("drop")
        return "dropped"

    async def _cache(_name):
        order.append("cache")
        return 3

    client.delete.side_effect = _delete_chunks
    client.drop_collection.side_effect = _drop
    mock_cache.side_effect = _cache

    from backend.services.kb_entry_manage import drop_kb_collection

    result = await drop_kb_collection(collection="public.test.col", chroma_url="http://chroma")

    assert result["ok"] is True
    assert result["purged"] is True
    assert result["dropped"] is True
    assert result["removed_chunks"] == 2
    assert result["cache_removed"] == 3
    assert result["chroma_status"] == "dropped"
    assert order == ["chunks", "cache", "drop"]
    client.drop_collection.assert_called_once_with("public.test.col")


@patch("backend.services.kb_entry_manage.delete_cached_entries_by_collection", return_value=0)
@patch("backend.services.kb_entry_manage.ChromaHttpClient")
@pytest.mark.asyncio
async def test_drop_kb_collection_stops_when_purge_fails(MockClient, mock_cache):
    client = MockClient.return_value
    client.heartbeat.return_value = True
    client.collection_names.return_value = ["public.test.col"]
    client.list_all_ids.side_effect = RuntimeError("list failed")

    from backend.services.kb_entry_manage import drop_kb_collection

    result = await drop_kb_collection(collection="public.test.col", chroma_url="http://chroma")

    assert result["ok"] is False
    client.drop_collection.assert_not_called()
    mock_cache.assert_not_awaited()


@patch("backend.services.kb_entry_manage.delete_cached_entries_by_collection", return_value=1)
@patch("backend.services.kb_entry_manage.ChromaHttpClient")
@pytest.mark.asyncio
async def test_drop_kb_collection_reports_shell_failure_after_purge(MockClient, mock_cache):
    client = MockClient.return_value
    client.heartbeat.return_value = True
    client.collection_names.return_value = ["public.test.col"]
    client.list_all_ids.return_value = ["a_chunk_1"]
    client.drop_collection.side_effect = RuntimeError("chroma 500")

    from backend.services.kb_entry_manage import drop_kb_collection

    result = await drop_kb_collection(collection="public.test.col", chroma_url="http://chroma")

    assert result["ok"] is False
    assert result["message"] == "collection_drop_failed"
    assert result["purged"] is True
    assert result["dropped"] is False
    assert result["cache_removed"] == 1
    client.delete.assert_called_once()
    mock_cache.assert_awaited_once()


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
