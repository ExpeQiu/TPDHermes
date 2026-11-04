"""本机账号注册、登录，以及会话覆盖请求身份。"""

from uuid import uuid4

from fastapi.testclient import TestClient

from backend import app
from backend.services.local_auth import issue_session_token, read_session_token
from backend.services.user_identity import effective_user_id_for_api
from starlette.requests import Request


def test_session_token_roundtrip():
    token = issue_session_token(user_id="user_abc", username="ada", display_name="Ada")
    payload = read_session_token(token)
    assert payload is not None
    assert payload["uid"] == "user_abc"
    assert read_session_token(token + "x") is None


def test_local_session_beats_header(monkeypatch):
    monkeypatch.setenv("TPDHERMES_TRUST_USER_ID_HEADER", "1")
    token = issue_session_token(user_id="user_real", username="ada", display_name="Ada")
    scope = {
        "type": "http",
        "headers": [
            (b"x-user-id", b"forged"),
            (b"x-local-session-token", token.encode()),
        ],
        "client": ("127.0.0.1", 1),
    }
    assert effective_user_id_for_api(Request(scope)) == "user_real"


def test_register_login_and_me_identity():
    suffix = uuid4().hex[:8]
    username = f"ada{suffix}"
    employee_id = f"E{suffix}"
    with TestClient(app) as client:
        created = client.post(
            "/api/v1/auth/register",
            json={
                "username": username,
                "employee_id": employee_id,
                "org_id": "ORG01",
                "password": "geely123",
            },
        )
        assert created.status_code == 200, created.text
        body = created.json()
        assert body["username"] == username
        assert body["display_name"] == username
        assert body["employee_id"] == employee_id
        assert body["org_id"] == "ORG01"
        assert body["user_id"].startswith("user_")
        token = body["token"]

        access = client.get("/api/v1/me/access", headers={"X-Local-Session-Token": token})
        assert access.status_code == 200
        assert access.json()["platform_role"] == "tenant_partner"
        assert access.json()["platform_role_label"] == "项目成员"

        duplicate = client.post(
            "/api/v1/auth/register",
            json={"username": username, "employee_id": f"X{suffix}", "org_id": "ORG01", "password": "geely123"},
        )
        assert duplicate.status_code == 409

        wrong = client.post(
            "/api/v1/auth/login",
            json={"username": username, "password": "nope-no"},
        )
        assert wrong.status_code == 401

        logged = client.post(
            "/api/v1/auth/login",
            json={"username": employee_id, "password": "geely123"},
        )
        assert logged.status_code == 200
        assert logged.json()["user_id"] == body["user_id"]

        me = client.get(
            "/api/v1/me",
            headers={"X-Local-Session-Token": token, "X-User-ID": "someone-else"},
        )
        assert me.status_code == 200
        assert me.json()["user_id"] == body["user_id"]
        assert me.json()["name"] == username

        session = client.get("/api/v1/auth/session", headers={"X-Local-Session-Token": token})
        assert session.status_code == 200
        assert session.json()["employee_id"] == employee_id
        assert session.json()["org_id"] == "ORG01"
        assert session.json()["platform_role_label"] == "项目成员"

        logout = client.post("/api/v1/auth/logout", headers={"X-Local-Session-Token": token})
        assert logout.status_code == 200
