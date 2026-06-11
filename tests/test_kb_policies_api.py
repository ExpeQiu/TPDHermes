import uuid

from fastapi.testclient import TestClient

from backend import app

HDR_ADMIN = {"X-User-ID": "default"}


def test_kb_policy_api_lifecycle(monkeypatch):
    monkeypatch.setenv("KB_EMBED_WARMUP", "0")
    code = f"kb-policy-{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        created = client.post(
            "/api/v1/kb/policies/",
            headers=HDR_ADMIN,
            json={
                "code": code,
                "name": "策略 API 回归",
                "description": "created by api test",
                "config": {
                    "mode": "restricted",
                    "collections": ["public.api.policy"],
                    "write_control": {"allowed_collections": ["public.api.policy"]},
                },
            },
        )
        assert created.status_code == 200, created.text
        policy = created.json()
        policy_id = policy["id"]
        assert policy["status"] == "draft"

        listed = client.get("/api/v1/kb/policies/", headers=HDR_ADMIN)
        assert listed.status_code == 200, listed.text
        assert any(item["id"] == policy_id for item in listed.json()["items"])

        updated = client.put(
            f"/api/v1/kb/policies/{policy_id}",
            headers=HDR_ADMIN,
            json={
                "name": "策略 API 回归 2",
                "description": "updated",
                "config": {
                    "mode": "restricted",
                    "collections": ["public.api.policy.v2"],
                    "write_control": {"allowed_collections": ["public.api.policy.v2"]},
                },
            },
        )
        assert updated.status_code == 200, updated.text
        assert updated.json()["name"] == "策略 API 回归 2"

        submit = client.post(f"/api/v1/kb/policies/{policy_id}/submit", headers=HDR_ADMIN)
        assert submit.status_code == 200, submit.text
        assert submit.json()["status"] == "pending_approval"

        approve = client.post(f"/api/v1/kb/policies/{policy_id}/approve", headers=HDR_ADMIN)
        assert approve.status_code == 200, approve.text
        assert approve.json()["status"] == "approved"

        publish = client.post(f"/api/v1/kb/policies/{policy_id}/publish", headers=HDR_ADMIN)
        assert publish.status_code == 200, publish.text
        assert publish.json()["status"] == "published"

        offline = client.post(f"/api/v1/kb/policies/{policy_id}/offline", headers=HDR_ADMIN)
        assert offline.status_code == 200, offline.text
        assert offline.json()["status"] == "offline"

        versions = client.get(f"/api/v1/kb/policies/{policy_id}/versions", headers=HDR_ADMIN)
        assert versions.status_code == 200, versions.text
        items = versions.json()["items"]
        assert len(items) >= 6
        assert items[0]["status"] == "offline"


def test_kb_policy_can_bind_project_and_scenario(monkeypatch):
    monkeypatch.setenv("KB_EMBED_WARMUP", "0")
    code = f"kb-bind-{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        created = client.post(
            "/api/v1/kb/policies/",
            headers=HDR_ADMIN,
            json={
                "code": code,
                "name": "绑定测试策略",
                "config": {
                    "mode": "restricted",
                    "write_control": {"allowed_collections": ["public.bind.test"]},
                },
            },
        )
        assert created.status_code == 200, created.text
        policy_id = created.json()["id"]

        project = client.post(
            "/api/v1/projects/",
            headers=HDR_ADMIN,
            json={"name": f"项目-{uuid.uuid4().hex[:6]}"},
        )
        assert project.status_code == 200, project.text
        project_id = project.json()["id"]

        scenario = client.post(
            "/api/v1/scenarios/",
            headers=HDR_ADMIN,
            json={
                "code": f"scn-{uuid.uuid4().hex[:6]}",
                "name": "场景绑定测试",
                "conversation_mode": "task_oriented",
            },
        )
        assert scenario.status_code == 200, scenario.text
        scenario_id = scenario.json()["id"]

        bind_project = client.put(
            f"/api/v1/projects/{project_id}",
            headers=HDR_ADMIN,
            json={"knowledge_policy_id": policy_id},
        )
        assert bind_project.status_code == 200, bind_project.text
        assert bind_project.json()["knowledge_policy_id"] == policy_id

        bind_scenario = client.put(
            f"/api/v1/scenarios/{scenario_id}",
            headers=HDR_ADMIN,
            json={"knowledge_policy_id": policy_id},
        )
        assert bind_scenario.status_code == 200, bind_scenario.text
        assert bind_scenario.json()["knowledge_policy_id"] == policy_id

        project_list = client.get("/api/v1/projects/", headers=HDR_ADMIN)
        assert project_list.status_code == 200, project_list.text
        assert any(
            item["id"] == project_id and item["knowledge_policy_id"] == policy_id
            for item in project_list.json()
        )

        scenario_list = client.get("/api/v1/scenarios/", headers=HDR_ADMIN)
        assert scenario_list.status_code == 200, scenario_list.text
        assert any(
            item["id"] == scenario_id and item["knowledge_policy_id"] == policy_id
            for item in scenario_list.json()
        )
