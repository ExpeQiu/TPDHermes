"""Role 组与项目成员权限测试。"""

from fastapi.testclient import TestClient

from backend import app

HDR_OWNER = {"X-User-ID": "rbac_owner", "X-User-Role": "tenant_admin"}
HDR_EDITOR = {"X-User-ID": "rbac_editor", "X-User-Role": "tenant_editor"}
HDR_VIEWER = {"X-User-ID": "rbac_viewer", "X-User-Role": "tenant_viewer"}


def test_platform_role_persist_and_access_features():
    with TestClient(app) as client:
        put = client.put("/api/v1/me/role", headers=HDR_VIEWER, json={"platform_role": "tenant_viewer"})
        assert put.status_code == 200
        access = client.get("/api/v1/me/access", headers=HDR_VIEWER).json()
        assert access["platform_role"] == "tenant_viewer"
        assert "create" not in access["features"]
        assert "projects" in access["features"]


def test_tenant_editor_blocked_from_scenarios_api():
    with TestClient(app) as client:
        client.put("/api/v1/me/role", headers=HDR_EDITOR, json={"platform_role": "tenant_editor"})
        resp = client.get("/api/v1/scenarios/", headers=HDR_EDITOR)
        assert resp.status_code == 403


def test_project_member_can_read_but_not_write():
    with TestClient(app) as client:
        created = client.post("/api/v1/projects/", json={"name": "RBAC Member"}, headers=HDR_OWNER).json()
        pid = created["id"]
        add = client.post(
            f"/api/v1/projects/{pid}/members",
            headers=HDR_OWNER,
            json={"user_id": "rbac_viewer", "role": "viewer"},
        )
        assert add.status_code == 200

        listed = client.get("/api/v1/projects/", headers=HDR_VIEWER)
        assert listed.status_code == 200
        assert pid in {p["id"] for p in listed.json()}

        detail = client.get(f"/api/v1/projects/{pid}", headers=HDR_VIEWER).json()
        assert detail["my_role"] == "viewer"

        denied = client.put(
            f"/api/v1/projects/{pid}",
            headers=HDR_VIEWER,
            json={"name": "Hacked"},
        )
        assert denied.status_code == 404


def test_project_editor_can_write():
    with TestClient(app) as client:
        created = client.post("/api/v1/projects/", json={"name": "RBAC Editor"}, headers=HDR_OWNER).json()
        pid = created["id"]
        client.post(
            f"/api/v1/projects/{pid}/members",
            headers=HDR_OWNER,
            json={"user_id": "rbac_editor", "role": "editor"},
        )
        ok = client.put(
            f"/api/v1/projects/{pid}",
            headers=HDR_EDITOR,
            json={"description": "updated by editor"},
        )
        assert ok.status_code == 200
        assert ok.json()["description"] == "updated by editor"


def test_client_role_header_cannot_elevate_without_server_pref():
    """默认不信任 X-User-Role 提权；须 PUT /me/role 写入服务端偏好。"""
    hdr = {"X-User-ID": "header_forge_user", "X-User-Role": "platform_admin"}
    with TestClient(app) as client:
        access = client.get("/api/v1/me/access", headers=hdr).json()
        assert access["platform_role"] != "platform_admin"
        assert "ops" not in access["features"]

        metrics = client.get("/api/v1/metrics/feature-usage", headers=hdr)
        assert metrics.status_code == 403

        saved = client.put(
            "/api/v1/me/role",
            headers={"X-User-ID": "header_forge_user"},
            json={"platform_role": "tenant_viewer"},
        )
        assert saved.status_code == 200
        access2 = client.get("/api/v1/me/access", headers=hdr).json()
        assert access2["platform_role"] == "tenant_viewer"
