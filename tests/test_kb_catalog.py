"""知识库分类目录：业务域与目录路径的增删改查。"""

import json

import pytest

from backend.db import async_session_maker
from backend.models.kb_cache import KBCache
from backend.models.kb_catalog import KbCatalogItem
from backend.services.kb_catalog import (
    create_domain,
    create_folder,
    delete_domain,
    delete_folder,
    list_catalog,
    rename_folder,
    update_domain,
)


async def _cleanup(keys: list[str]) -> None:
    async with async_session_maker() as db:
        for key in keys:
            row = await db.get(KbCatalogItem, key)
            if row:
                await db.delete(row)
        await db.commit()


@pytest.mark.asyncio
async def test_domain_create_rename_and_delete():
    created = await create_domain(key="catalog_probe_domain", label="探针域")
    assert created["ok"] is True
    try:
        renamed = await update_domain(key="catalog_probe_domain", label="探针域二")
        assert renamed["label"] == "探针域二"
        listed = await list_catalog()
        hit = next(item for item in listed["domains"] if item["key"] == "catalog_probe_domain")
        assert hit["label"] == "探针域二"
        assert hit["builtin"] is False
        removed = await delete_domain("catalog_probe_domain")
        assert removed["ok"] is True
    finally:
        await _cleanup(["domain:catalog_probe_domain"])


@pytest.mark.asyncio
async def test_builtin_domain_cannot_be_deleted():
    result = await delete_domain("structured_tech")
    assert result["ok"] is False
    assert result["message"] == "builtin_domain"


@pytest.mark.asyncio
async def test_domain_in_use_cannot_be_deleted():
    await create_domain(key="catalog_busy_domain", label="占用域")
    async with async_session_maker() as db:
        db.add(
            KBCache(
                id="catalog_busy_chunk",
                project_id="__all__",
                collection="public.catalog_busy_domain.notes",
                content="body",
                metadata_=json.dumps({"doc_id": "catalog_busy", "domain": "catalog_busy_domain"}),
                source="test",
                created_at="2026-01-01",
                updated_at="2026-01-01",
            )
        )
        await db.commit()
    try:
        result = await delete_domain("catalog_busy_domain")
        assert result["message"] == "domain_in_use"
    finally:
        async with async_session_maker() as db:
            row = await db.get(KBCache, "catalog_busy_chunk")
            if row:
                await db.delete(row)
            await db.commit()
        await _cleanup(["domain:catalog_busy_domain"])


@pytest.mark.asyncio
async def test_rename_folder_rewrites_cache_when_chroma_misses(monkeypatch):
    async def _missing(**_kwargs):
        return {"ok": False, "message": "entry_not_found"}

    monkeypatch.setattr("backend.services.kb_catalog.update_kb_entry", _missing)
    async with async_session_maker() as db:
        db.add(
            KBCache(
                id="catalog_folder_chunk",
                project_id="__all__",
                collection="public.structured_tech.general",
                content="body",
                metadata_=json.dumps(
                    {
                        "doc_id": "catalog_folder_doc",
                        "domain": "structured_tech",
                        "folder_path": "02-知识库/探针目录",
                        "title": "探针",
                    }
                ),
                source="test",
                created_at="2026-01-01",
                updated_at="2026-01-01",
            )
        )
        await db.commit()
    try:
        result = await rename_folder(path="02-知识库/探针目录", new_path="02-知识库/探针目录已改")
        assert result["ok"] is True
        assert result["updated_docs"] == 1
        async with async_session_maker() as db:
            row = await db.get(KBCache, "catalog_folder_chunk")
            meta = json.loads(row.metadata_)
        assert meta["folder_path"] == "02-知识库/探针目录已改"
    finally:
        async with async_session_maker() as db:
            row = await db.get(KBCache, "catalog_folder_chunk")
            if row:
                await db.delete(row)
            await db.commit()


@pytest.mark.asyncio
async def test_delete_folder_keeps_real_documents():
    async with async_session_maker() as db:
        db.add(
            KBCache(
                id="catalog_real_chunk",
                project_id="__all__",
                collection="public.structured_tech.general",
                content="body",
                metadata_=json.dumps(
                    {
                        "doc_id": "catalog_real_doc",
                        "domain": "structured_tech",
                        "folder_path": "02-知识库/不能删",
                        "title": "正式文档",
                    }
                ),
                source="test",
                created_at="2026-01-01",
                updated_at="2026-01-01",
            )
        )
        await db.commit()
    try:
        result = await delete_folder("02-知识库/不能删")
        assert result["message"] == "folder_not_empty"
    finally:
        async with async_session_maker() as db:
            row = await db.get(KBCache, "catalog_real_chunk")
            if row:
                await db.delete(row)
            await db.commit()


@pytest.mark.asyncio
async def test_create_folder_stores_catalog_without_duplicate_index(monkeypatch):
    called = {"n": 0}

    async def _create(**_kwargs):
        called["n"] += 1
        return {"ok": True, "doc_id": "pathcat_x"}

    monkeypatch.setattr("backend.services.kb_catalog.create_kb_manual_entry", _create)
    result = await create_folder(
        path="02-知识库/目录探针",
        domain="structured_tech",
        scope="public",
    )
    try:
        assert result["ok"] is True
        assert called["n"] == 1
        listed = await list_catalog()
        assert any(item["path"] == "02-知识库/目录探针" for item in listed["folders"])
    finally:
        from backend.services.kb_ids import folder_catalog_item_id

        await _cleanup(
            [
                folder_catalog_item_id(
                    scope="public",
                    project_id="",
                    collection="public.structured_tech.general",
                    folder="02-知识库/目录探针",
                )
            ]
        )
