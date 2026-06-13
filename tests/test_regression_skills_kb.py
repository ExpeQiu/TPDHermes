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

    with TestClient(app) as client:
        lite = client.get(
            "/api/v1/kb/cache/entries/__all__?limit=50&include_content=false"
        )
    assert lite.status_code == 200
    lite_body = lite.json()
    assert rid in {e["id"] for e in lite_body["entries"]}
    assert lite_body["entries"][0].get("content") == ""


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


def test_marketplace_lists_user_created_skills():
    skill_name = f"market_user_skill_{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        created = client.post(
            "/api/v1/skills/upload",
            headers={"X-User-ID": "u_market_creator"},
            files={
                "file": (
                    f"{skill_name}.zip",
                    _build_skill_zip(skill_name),
                    "application/zip",
                )
            },
            data={"description": "market user skill"},
        )
        assert created.status_code == 200, created.text
        r = client.get("/api/v1/skills/marketplace")
        assert r.status_code == 200
        rows = r.json()
        names = {x["name"] for x in rows}
        assert skill_name in names
        created_row = next(x for x in rows if x["name"] == skill_name)
        assert created_row.get("publisher_id") == "u_market_creator"

        # 清理安装记录
        client.delete(f"/api/v1/skills/{skill_name}", headers={"X-User-ID": "u_market_creator"})


def test_marketplace_install_allows_cross_user_copy():
    base_name = f"market_install_skill_{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        created = client.post(
            "/api/v1/skills/upload",
            headers={"X-User-ID": "u_creator_install"},
            files={
                "file": (
                    f"{base_name}.zip",
                    _build_skill_zip(base_name),
                    "application/zip",
                )
            },
            data={"description": "creator skill"},
        )
        assert created.status_code == 200, created.text

        installed = client.post(
            "/api/v1/skills/marketplace/install",
            headers={"X-User-ID": "u_consumer_install"},
            json={"name": base_name},
        )
        assert installed.status_code == 200, installed.text
        payload = installed.json()
        assert payload["owner_id"] == "u_consumer_install"
        assert payload["name"] != ""
        assert payload["name"].startswith(base_name)

        # 清理：创建者原技能 + 使用者副本
        client.delete(f"/api/v1/skills/{base_name}", headers={"X-User-ID": "u_creator_install"})
        client.delete(f"/api/v1/skills/{payload['name']}", headers={"X-User-ID": "u_consumer_install"})


def _build_skill_zip(skill_name: str) -> bytes:
    import io
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            f"{skill_name}/SKILL.md",
            f"---\nname: {skill_name}\ndescription: test\n---\n\n# {skill_name}\n",
        )
    return buf.getvalue()
