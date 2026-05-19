"""项目 owner_id 隔离。"""

from fastapi.testclient import TestClient

from backend import app

HDR_A = {"X-User-ID": "isolate_user_a"}
HDR_B = {"X-User-ID": "isolate_user_b"}


def test_project_not_visible_to_other_user():
    with TestClient(app) as client:
        pa = client.post("/api/v1/projects/", json={"name": "Iso A"}, headers=HDR_A).json()
        pid = pa["id"]
        r_list = client.get("/api/v1/projects/", headers=HDR_B)
        assert r_list.status_code == 200
        ids = {p["id"] for p in r_list.json()}
        assert pid not in ids
        r_get = client.get(f"/api/v1/projects/{pid}", headers=HDR_B)
        assert r_get.status_code == 404


def test_tasks_execute_rejects_foreign_project():
    with TestClient(app) as client:
        pa = client.post("/api/v1/projects/", json={"name": "Iso Task"}, headers=HDR_A).json()
        pid = pa["id"]
        r = client.post(
            "/api/v1/tasks/execute",
            headers=HDR_B,
            json={
                "entrypoint": "chat",
                "project_id": pid,
                "user_message": "hi",
                "stream": False,
            },
        )
        assert r.status_code == 404
