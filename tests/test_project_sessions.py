"""项目 session 可互查，项目文件夹对四种 session 共享增删改查。"""

from fastapi.testclient import TestClient

from backend import app


def test_sessions_share_project_folder():
    with TestClient(app) as client:
        project_id = client.post("/api/v1/projects/", json={"name": "共享文件夹"}).json()["id"]
        dialogue = client.post(
            f"/api/v1/projects/{project_id}/sessions",
            json={"kind": "dialogue", "source_id": "chat-1", "title": "对话一"},
        )
        scene = client.post(
            f"/api/v1/projects/{project_id}/sessions",
            json={"kind": "scene", "source_id": "V04:p", "title": "场景"},
        )
        assert dialogue.status_code == 200
        assert scene.status_code == 200
        listed = client.get(f"/api/v1/projects/{project_id}/sessions")
        kinds = {item["kind"] for item in listed.json()["items"]}
        assert {"dialogue", "scene"} <= kinds

        created = client.post(
            f"/api/v1/projects/{project_id}/folder",
            json={
                "session_id": dialogue.json()["id"],
                "action": "create",
                "title": "共享稿",
                "content": "原文",
            },
        )
        assert created.status_code == 200
        file_id = created.json()["id"]
        assert created.json()["session_id"] == dialogue.json()["id"]

        updated = client.post(
            f"/api/v1/projects/{project_id}/folder",
            json={
                "session_id": scene.json()["id"],
                "action": "update",
                "file_id": file_id,
                "content": "场景改过的全文",
            },
        )
        assert updated.status_code == 200
        assert updated.json()["session_id"] == dialogue.json()["id"]
        assert updated.json()["actor_session_id"] == scene.json()["id"]
        detail = client.get(f"/api/v1/projects/{project_id}/files/{file_id}?kind=output")
        assert detail.json()["content"] == "场景改过的全文"
        assert detail.json()["session_kind"] == "dialogue"

        archived = client.post(
            f"/api/v1/projects/{project_id}/folder",
            json={"session_id": scene.json()["id"], "action": "archive", "file_id": file_id},
        )
        assert archived.status_code == 200
        files = client.get(f"/api/v1/projects/{project_id}/files")
        assert file_id not in {item["id"] for item in files.json()["items"]}


def test_chat_without_project_is_not_a_project_session():
    with TestClient(app) as client:
        project_id = client.post("/api/v1/projects/", json={"name": "无绑定"}).json()["id"]
        created = client.post(
            "/api/v1/chat/sessions",
            json={"title": "游离对话", "sessionKind": "chat", "messages": []},
        )
        assert created.status_code == 200
        listed = client.get(f"/api/v1/projects/{project_id}/sessions")
        assert created.json()["id"] not in {item["source_id"] for item in listed.json()["items"]}
