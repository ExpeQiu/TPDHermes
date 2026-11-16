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


def test_studio_turn_mock_e2e(monkeypatch):
    """样本演示不碰项目；真实资料回合只把授权正文交给工作台，只读成员不能发起。"""
    seen: list[dict] = []

    async def fake_call(command, payload=None, *, product="V04", needs_model=None):
        seen.append({"command": command, "payload": payload or {}, "product": product})
        if command == "capabilities":
            return {"configured": True, "operations": ["extract", "gaps", "lock"]}
        return {
            "revision": 1,
            "operation": (payload or {}).get("operation"),
            "source_title": ((payload or {}).get("source") or {}).get("title"),
            "source_text": ((payload or {}).get("source") or {}).get("text"),
        }

    monkeypatch.setattr("backend.routes.studio.call_tpcstore", fake_call)
    owner = "studio_owner_e2e"
    viewer = "studio_viewer_e2e"
    with TestClient(app) as client:
        config = client.get("/api/v1/studio/config")
        assert config.status_code == 200, config.text
        assert config.json()["connected"] is True
        demo = client.post(
            "/api/v1/studio/turn",
            headers={"X-User-ID": owner},
            json={"message": "提取技术卡", "demo": True},
        )
        assert demo.status_code == 200, demo.text
        assert demo.json()["driver"] == "mock"
        assert demo.json()["state"]["cards"]
        mixed = client.post(
            "/api/v1/studio/turn",
            headers={"X-User-ID": owner},
            json={"message": "提取技术卡", "demo": True, "project_id": "x"},
        )
        assert mixed.status_code == 422

        project_id = client.post(
            "/api/v1/projects/",
            headers={"X-User-ID": owner},
            json={"name": "工作室端到端"},
        ).json()["id"]
        client.post(
            f"/api/v1/projects/{project_id}/members",
            headers={"X-User-ID": owner},
            json={"user_id": viewer, "role": "viewer"},
        )
        created = client.post(
            f"/api/v1/projects/{project_id}/file-actions/apply",
            headers={"X-User-ID": owner},
            json={
                "proposal_id": "studio-e2e-file",
                "action": {
                    "type": "create",
                    "file_name": "技术说明.md",
                    "path": "/资料",
                    "content": "热管理在零下7度8分钟升温。",
                },
            },
        )
        assert created.status_code == 200, created.text
        file_id = created.json()["file_id"]
        turned = client.post(
            "/api/v1/studio/turn",
            headers={"X-User-ID": owner},
            json={
                "message": "提取技术卡",
                "project_id": project_id,
                "file_id": file_id,
                "file_kind": "output",
            },
        )
        assert turned.status_code == 200, turned.text
        assert turned.json()["operation"] == "extract"
        assert "8分钟" in turned.json()["source_text"]
        denied = client.post(
            "/api/v1/studio/turn",
            headers={"X-User-ID": viewer},
            json={
                "message": "提取技术卡",
                "project_id": project_id,
                "file_id": file_id,
                "file_kind": "output",
            },
        )
        assert denied.status_code in {403, 404}
    assert seen[-1]["payload"]["source"]["text"].startswith("热管理")
