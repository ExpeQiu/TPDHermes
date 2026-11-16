"""V05 / V10 宿主通路：项目权限后才调用 CLI，示例只导入一次。"""

from fastapi.testclient import TestClient

from backend import app
from backend.services import studio_apps


def test_unknown_operation_rejected(monkeypatch):
    async def fail(*_args, **_kwargs):
        raise AssertionError("不应调用 CLI")

    monkeypatch.setattr(studio_apps, "call_tpcstore", fail)
    with TestClient(app) as client:
        created = client.post("/api/v1/projects/", json={"name": "价值链权限"})
        assert created.status_code == 200
        denied = client.post(
            "/api/v1/studio/apps/V05/workspace",
            json={"operation": "publish", "project_id": created.json()["id"]},
        )
        assert denied.status_code == 422


def test_v07_unknown_operation_rejected(monkeypatch):
    async def fail(*_args, **_kwargs):
        raise AssertionError("不应调用 CLI")

    monkeypatch.setattr(studio_apps, "call_tpcstore", fail)
    with TestClient(app) as client:
        created = client.post("/api/v1/projects/", json={"name": "信息屋权限"})
        assert created.status_code == 200
        denied = client.post(
            "/api/v1/studio/apps/V07/workspace",
            json={"operation": "publish", "project_id": created.json()["id"]},
        )
        assert denied.status_code == 422


def test_chat_imports_fixture_once(monkeypatch):
    calls = []

    async def fake(command, payload=None, *, product="V04", needs_model=None):
        calls.append((product, command, dict(payload or {})))
        operation = (payload or {}).get("operation")
        if operation == "show" and len(calls) == 1:
            return {"revision": 0, "facts": [], "links": [], "cards": []}
        return {
            "revision": 1,
            "facts": (payload or {}).get("facts") or [{"object_id": "kept"}],
            "links": [],
            "cards": [],
        }

    monkeypatch.setattr(studio_apps, "call_tpcstore", fake)
    monkeypatch.setattr(
        studio_apps,
        "read_product_fixture",
        lambda product: {
            "facts": [{"object_id": "tech/principle"}],
            "scenario": "低速",
            "derivation": "推导",
            "benefit": "平稳",
            "unverified_claim": "全系",
            "target_user": "驾驶者",
        },
    )
    with TestClient(app) as client:
        project_id = client.post("/api/v1/projects/", json={"name": "价值链示例"}).json()["id"]
        loaded = client.post(
            "/api/v1/studio/apps/V05/chat",
            json={"project_id": project_id, "message": "载入示例"},
        )
        assert loaded.status_code == 200
        assert loaded.json()["revision"] == 1
        imported = calls[1][2]
        assert imported["operation"] == "import"
        assert imported["project_id"] == project_id
        assert imported["facts"][0]["object_id"] == "tech/principle"
        again = client.post(
            "/api/v1/studio/apps/V05/chat",
            json={"project_id": project_id, "message": "载入示例"},
        )
        assert again.status_code == 200
        assert "未重复导入" in again.json()["reply"]
        assert [item[2]["operation"] for item in calls] == ["show", "import", "show"]
