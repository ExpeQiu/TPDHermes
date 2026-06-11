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


def test_chat_session_patch_and_message_sync():
    headers = {"X-User-ID": f"patch_user_{uuid.uuid4().hex[:8]}"}
    with TestClient(app) as client:
        assistant_id = f"m2-{uuid.uuid4().hex[:8]}"
        create = client.post(
            "/api/v1/chat/sessions",
            headers=headers,
            json={
                "title": "原始标题",
                "messages": [{"id": f"m1-{uuid.uuid4().hex[:8]}", "role": "user", "content": "你好"}],
                "selectedCollection": "default-kb",
            },
        )
        assert create.status_code == 200
        sid = create.json()["id"]

        patched = client.patch(
            f"/api/v1/chat/sessions/{sid}",
            headers=headers,
            json={
                "title": "已修正标题",
                "selectedCollection": "team-kb",
                "includeKnowledgeContext": True,
            },
        )
        assert patched.status_code == 200
        patched_body = patched.json()
        assert patched_body["title"] == "已修正标题"
        assert patched_body["selectedCollection"] == "team-kb"
        assert patched_body["includeKnowledgeContext"] is True

        sync_added = client.post(
            f"/api/v1/chat/sessions/{sid}/messages/sync",
            headers=headers,
            json={
                "messages": [
                    {
                        "id": assistant_id,
                        "role": "assistant",
                        "content": "第一版回答",
                        "runId": "run-1",
                    }
                ]
            },
        )
        assert sync_added.status_code == 200
        sync_body = sync_added.json()
        assert sync_body["stats"]["created"] == 1
        assert sync_body["session"]["messages"][-1]["content"] == "第一版回答"

        sync_updated = client.post(
            f"/api/v1/chat/sessions/{sid}/messages/sync",
            headers=headers,
            json={
                "messages": [
                    {
                        "id": assistant_id,
                        "role": "assistant",
                        "content": "最终回答",
                        "runId": "run-1",
                        "citations": [{"title": "source-a"}],
                    }
                ]
            },
        )
        assert sync_updated.status_code == 200
        sync_updated_body = sync_updated.json()
        assert sync_updated_body["stats"]["rewritten"] == 1
        assert sync_updated_body["session"]["messages"][-1]["content"] == "最终回答"
        assert sync_updated_body["session"]["messages"][-1]["citations"][0]["title"] == "source-a"

        sync_removed = client.post(
            f"/api/v1/chat/sessions/{sid}/messages/sync",
            headers=headers,
            json={"messages": [], "removedMessageIds": [assistant_id]},
        )
        assert sync_removed.status_code == 200
        sync_removed_body = sync_removed.json()
        assert sync_removed_body["stats"]["deleted"] == 1
        remaining_ids = [item["id"] for item in sync_removed_body["session"]["messages"]]
        assert assistant_id not in remaining_ids


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
