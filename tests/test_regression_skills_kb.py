"""技能安装/版本快照、知识库缓存全量、SSE 载荷的回归保护。"""

import uuid
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from backend import app
from backend.db import async_session_maker
from backend.models.kb_cache import KBCache
from backend.routes.kb_sse import KBEvent
from backend.services.kb_cache import kb_cache_service


def test_kb_event_sse_payload_has_type_alias():
    ev = KBEvent("sync_complete", project_id="p1", collection="c1")
    d = ev.to_dict()
    assert d["event_type"] == "sync_complete"
    assert d["type"] == "sync_complete"


@pytest.mark.asyncio
async def test_kb_cache_entries_all_projects_semantic():
    await kb_cache_service.ensure_table()
    rid = str(uuid.uuid4())
    async with async_session_maker() as db:
        db.add(
            KBCache(
                id=rid,
                project_id="proj-regression",
                collection="col_a",
                content="body",
                metadata_="{}",
                source="test",
                created_at=datetime.now().isoformat(),
                updated_at=datetime.now().isoformat(),
                sync_status="synced",
                reliability=0.9,
                version=1,
            )
        )
        await db.commit()

    with TestClient(app) as client:
        r = client.get("/api/v1/kb/cache/entries/__all__?limit=50")
    assert r.status_code == 200
    body = r.json()
    ids = {e["id"] for e in body["entries"]}
    assert rid in ids


def test_skill_install_rejects_missing_package():
    with TestClient(app) as client:
        r = client.post(
            "/api/v1/skills/",
            json={"name": "nonexistent_skill_xyz", "description": "x", "source": "local"},
        )
    assert r.status_code == 409
    assert "目录" in r.json().get("detail", "") or "技能" in r.json().get("detail", "")


def test_skill_version_load_after_snapshot():
    with TestClient(app) as client:
        iname = "hello_skill"
        # 若已安装先卸载（忽略失败）
        client.delete(f"/api/v1/skills/{iname}")
        r0 = client.post(
            "/api/v1/skills/",
            json={"name": iname, "description": "t", "source": "local"},
        )
        assert r0.status_code == 200, r0.text
        r1 = client.post(f"/api/v1/skills/{iname}/versions/1.0.0/load")
    assert r1.status_code == 200, r1.text
    data = r1.json()
    assert data.get("name") == iname
    assert data.get("version_loaded") == "1.0.0"


def test_marketplace_lists_only_real_skill_names():
    with TestClient(app) as client:
        r = client.get("/api/v1/skills/marketplace")
    assert r.status_code == 200
    names = {x["name"] for x in r.json()}
    assert "video_script_skill" not in names
    assert "hello_skill" in names
    assert names <= {"hello_skill", "speech_skill", "video_skill", "a4_skill"}
