"""KB：全库检索、单条拉取、只读恢复、SSE 订阅释放。"""

import uuid
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from backend import app
from backend.db import async_session_maker
from backend.models.kb_cache import KBCache
from backend.routes.kb_sse import KBSubscriptionManager
from backend.services.kb_cache import kb_cache_service
from backend.services.kb_proxy import kb_proxy_service


@pytest.mark.asyncio
async def test_readonly_sticky_cleared_when_upstream_probe_ok(monkeypatch):
    async def chroma_up():
        return True

    monkeypatch.setattr(kb_proxy_service, "_probe_chroma", chroma_up)
    kb_proxy_service._readonly_mode = True
    h = await kb_proxy_service.health_check()
    assert kb_proxy_service._readonly_mode is False
    assert h["external_kb"] == "up"


@pytest.mark.asyncio
async def test_kb_subscription_unsubscribe_drops_subscriber():
    m = KBSubscriptionManager()
    sub = await m.subscribe()
    assert m.active_count >= 1
    await m.unsubscribe(sub)
    assert m.active_count == 0


@pytest.mark.asyncio
async def test_cache_get_entry_by_id_roundtrip():
    await kb_cache_service.ensure_table()
    rid = f"unit-{uuid.uuid4()}"
    async with async_session_maker() as db:
        db.add(
            KBCache(
                id=rid,
                project_id="p-x",
                collection="col_deep",
                content="unique marker alpha-beta tree open",
                metadata_='{"title":"T1","projects":[7]}',
                source="t",
                created_at=datetime.now().isoformat(),
                updated_at=datetime.now().isoformat(),
                sync_status="synced",
                reliability=0.9,
                version=1,
            )
        )
        await db.commit()

    with TestClient(app) as client:
        r = client.get(f"/api/v1/kb/cache/entry/{rid}")
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == rid
    assert "alpha-beta" in body["content"]


@pytest.mark.asyncio
async def test_query_all_finds_across_collections_in_cache_mode(monkeypatch):
    """
    Chroma 不可用时走缓存合并路径：两集合各一条，子串均能命中。
    """
    await kb_cache_service.ensure_table()
    a = f"qa-{uuid.uuid4()}"
    b = f"qb-{uuid.uuid4()}"
    async with async_session_maker() as db:
        db.add(
            KBCache(
                id=a,
                project_id="__all__",
                collection="c_one",
                content="zzz qwertysplit_one unique",
                metadata_="{}",
                source="t",
                created_at=datetime.now().isoformat(),
                updated_at=datetime.now().isoformat(),
                sync_status="synced",
                reliability=0.9,
                version=1,
            )
        )
        db.add(
            KBCache(
                id=b,
                project_id="__all__",
                collection="c_two",
                content="yyy qwertysplit_two another",
                metadata_="{}",
                source="t",
                created_at=datetime.now().isoformat(),
                updated_at=datetime.now().isoformat(),
                sync_status="synced",
                reliability=0.85,
                version=1,
            )
        )
        await db.commit()

    async def chroma_down():
        return False

    monkeypatch.setattr(kb_proxy_service, "_probe_chroma", chroma_down)
    kb_proxy_service._readonly_mode = False
    out = await kb_proxy_service.query_all_collections(
        "qwertysplit",
        n_results=10,
        project_id="__all__",
    )
    assert out["source"] == "cache"
    ids = {out["results"][i]["metadata"].get("id") for i in range(len(out["results"]))}
    # metadata may not have id; fallback content check
    blobs = " ".join(
        str(out["results"][i].get("content", "")) for i in range(len(out["results"]))
    )
    assert "qwertysplit_one" in blobs
    assert "qwertysplit_two" in blobs

