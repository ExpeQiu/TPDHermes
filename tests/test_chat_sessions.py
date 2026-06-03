"""聊天会话与服务端身份 API 测试。"""

import uuid

from fastapi.testclient import TestClient

from backend import app

TEST_USER = f"test_chat_user_{uuid.uuid4().hex[:8]}"


def test_chat_sessions_crud():
    headers = {"X-User-ID": TEST_USER}
    with TestClient(app) as client:
        create = client.post(
            "/api/v1/chat/sessions",
            headers=headers,
            json={
                "title": "测试对话",
                "messages": [{"id": f"m1-{uuid.uuid4().hex[:8]}", "role": "user", "content": "你好"}],
                "createdAt": 1_700_000_000_000,
            },
        )
        assert create.status_code == 200
        session = create.json()
        sid = session["id"]
        assert session["title"] == "测试对话"
        assert len(session.get("messages") or []) == 1

        listed = client.get("/api/v1/chat/sessions?full=1", headers=headers)
        assert listed.status_code == 200
        items = listed.json().get("items") or []
        assert any(item["id"] == sid for item in items)

        updated = client.put(
            f"/api/v1/chat/sessions/{sid}",
            headers=headers,
            json={
                "title": "更新标题",
                "messages": [
                    {"id": f"m1-{uuid.uuid4().hex[:8]}", "role": "user", "content": "你好"},
                    {"id": f"m2-{uuid.uuid4().hex[:8]}", "role": "assistant", "content": "您好"},
                ],
            },
        )
        assert updated.status_code == 200
        assert updated.json()["title"] == "更新标题"
        assert len(updated.json().get("messages") or []) == 2

        deleted = client.delete(f"/api/v1/chat/sessions/{sid}", headers=headers)
        assert deleted.status_code == 200


def test_me_identity_sync():
    headers = {"X-User-ID": "identity_sync_user"}
    with TestClient(app) as client:
        unified = "user_test_unified_abc"
        put = client.put(
            "/api/v1/me/identity",
            headers=headers,
            json={"unified_user_id": unified},
        )
        assert put.status_code == 200
        assert put.json().get("unified_user_id") == unified

        get = client.get("/api/v1/me/identity", headers=headers)
        assert get.status_code == 200
        body = get.json()
        assert body.get("unified_user_id") == unified


def test_chat_sessions_isolated_by_user():
    with TestClient(app) as client:
        r1 = client.post(
            "/api/v1/chat/sessions",
            headers={"X-User-ID": "user_a"},
            json={"title": "A", "messages": []},
        )
        r2 = client.post(
            "/api/v1/chat/sessions",
            headers={"X-User-ID": "user_b"},
            json={"title": "B", "messages": []},
        )
        assert r1.status_code == 200 and r2.status_code == 200

        list_a = client.get("/api/v1/chat/sessions", headers={"X-User-ID": "user_a"}).json()
        list_b = client.get("/api/v1/chat/sessions", headers={"X-User-ID": "user_b"}).json()
        titles_a = {item["title"] for item in list_a.get("items") or []}
        titles_b = {item["title"] for item in list_b.get("items") or []}
        assert "A" in titles_a
        assert "B" in titles_b
        assert "B" not in titles_a
