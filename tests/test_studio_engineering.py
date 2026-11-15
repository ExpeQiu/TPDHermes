"""技能卡工程文件：V04 事实写入项目输出，V05 只从这份文件导入。"""

import json

from fastapi.testclient import TestClient

from backend import app
from backend.services import studio_engineering


def test_v04_file_imports_into_v05(monkeypatch):
    calls = []

    async def fake_v04(command, payload=None, *, product="V04", needs_model=None):
        return {
            "revision": 2,
            "source": {"id": "src"},
            "cards": [{
                "id": "c1", "term": "车身控制", "status": "checked", "version": 1,
                "definition": "低速具备车身控制能力", "principle": "调节悬架抑制俯仰",
                "parameter": "20 km/h", "scope": "低速干燥路面",
            }],
        }

    async def fake_app(db, *, product, user_id, payload):
        calls.append(dict(payload))
        if payload["operation"] == "show":
            return {"revision": 0, "facts": [], "cards": []}
        return {"revision": 1, "facts": payload.get("facts") or [], "cards": []}

    monkeypatch.setattr(studio_engineering, "call_tpcstore", fake_v04)
    monkeypatch.setattr(studio_engineering, "run_app_workspace", fake_app)
    with TestClient(app) as client:
        project_id = client.post("/api/v1/projects/", json={"name": "工程交接"}).json()["id"]
        source = client.post(
            f"/api/v1/projects/{project_id}/outputs/deposit-from-chat",
            json={"title": "资料", "content": "调节悬架抑制俯仰。"},
        )
        assert source.status_code == 200
        exported = client.post("/api/v1/studio/engineering", json={
            "action": "export", "product": "V04", "project_id": project_id,
            "file_id": source.json()["id"], "file_kind": "output",
        })
        assert exported.status_code == 200
        file_id = exported.json()["file_id"]
        stored = client.get(f"/api/v1/projects/{project_id}/outputs/{file_id}")
        document = json.loads(stored.json()["content"])
        assert document["kind"] == "tpcstore.engineering"
        assert document["product"] == "V04"
        assert any(item["kind"] == "principle" for item in document["facts"])
        imported = client.post("/api/v1/studio/engineering", json={
            "action": "import", "product": "V05", "project_id": project_id, "file_id": file_id,
        })
        assert imported.status_code == 200
        assert calls[-1]["operation"] == "import"
        assert calls[-1]["facts"][0]["text"]
        rejected = client.post("/api/v1/studio/engineering", json={
            "action": "import", "product": "V10", "project_id": project_id, "file_id": file_id,
        })
        assert rejected.status_code == 422
