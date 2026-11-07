"""数字员工：看用管、复制、快照、钥匙、飞书去重与检索预览。"""

from uuid import uuid4

from fastapi.testclient import TestClient

from backend import app
from backend.services.digital_employee_service import knowledge_query, model_facing_excerpts


def test_model_excerpts_are_numbered_and_short():
    items = model_facing_excerpts(
        [{"title": "制度", "source": "doc-1", "version": "v1", "content": "甲" * 2000}]
    )
    assert items[0]["label"] == "[1]"
    assert len(items[0]["excerpt"]) == 1200
    assert items[0]["version"] == "v1"


def test_preview_failure_keeps_plan():
    plan = {"steps": ["keep"]}
    result = knowledge_query(
        {"knowledge": [{"id": "kb", "version": "1"}]},
        purpose="govern_preview",
        hits=[{"collection": "kb", "content": "新内容"}],
        plan=plan,
        preview_failed=True,
    )
    assert result["applied"] is False
    assert result["plan"] == plan
    assert result["excerpts"] == []


def test_employee_lifecycle_copy_key_and_feishu():
    suffix = uuid4().hex[:8]
    owner = {"X-User-ID": f"owner_{suffix}", "X-User-Role": "tenant_admin", "X-User-Name": "jia"}
    other = {"X-User-ID": f"other_{suffix}", "X-User-Role": "tenant_partner", "X-User-Name": "yi"}
    with TestClient(app) as client:
        created = client.post(
            "/api/v1/employees",
            headers=owner,
            json={"name": f"员工{suffix}", "source_mode": "blank", "role_name": "待补充"},
        )
        assert created.status_code == 200, created.text
        employee_id = created.json()["id"]
        assert created.json()["display_name"].endswith("@jia")
        assert created.json()["can_use"] is True

        duplicate = client.post(
            "/api/v1/employees",
            headers=owner,
            json={"name": f"员工{suffix}", "source_mode": "blank"},
        )
        assert duplicate.status_code == 409

        bound = client.put(
            f"/api/v1/employees/{employee_id}/bindings",
            headers=owner,
            json={
                "items": [
                    {"resource_type": "skill", "resource_id": "speech", "resource_version": "1.2.0"},
                    {"resource_type": "knowledge", "resource_id": "kb-main", "resource_version": "3"},
                ]
            },
        )
        assert bound.status_code == 200, bound.text
        assert bound.json()["binding_count"] == 2

        published = client.put(
            f"/api/v1/employees/{employee_id}",
            headers=owner,
            json={"published_to_gallery": True},
        )
        assert published.status_code == 200
        assert published.json()["published_to_gallery"] is True

        gallery = client.get("/api/v1/employees?scope=gallery", headers=other)
        assert gallery.status_code == 200
        assert any(item["id"] == employee_id for item in gallery.json()["items"])
        selectable = client.get("/api/v1/employees?scope=selectable", headers=other)
        assert all(item["id"] != employee_id for item in selectable.json()["items"])

        copied = client.post(
            "/api/v1/employees",
            headers=other,
            json={"name": f"副本{suffix}", "source_mode": "copy", "copy_from_id": employee_id},
        )
        assert copied.status_code == 200, copied.text
        copy_id = copied.json()["id"]
        assert copied.json()["binding_count"] == 2
        assert copied.json()["owner_user_id"] == other["X-User-ID"]

        changed = client.put(
            f"/api/v1/employees/{copy_id}/bindings",
            headers=other,
            json={"items": [{"resource_type": "skill", "resource_id": "other-skill", "resource_version": "9"}]},
        )
        assert changed.status_code == 200
        source = client.get(f"/api/v1/employees/{employee_id}", headers=owner)
        assert {item["resource_id"] for item in source.json()["bindings"]} == {"speech", "kb-main"}

        draft = client.post(f"/api/v1/employees/{employee_id}/draft-runs", headers=owner, json={})
        assert draft.status_code == 200, draft.text
        assert draft.json()["status"] == "draft"
        assert draft.json()["snapshot"]["skills"][0]["version"] == "1.2.0"

        key = client.post(f"/api/v1/employees/{employee_id}/credentials", headers=owner)
        assert key.status_code == 200
        token = key.json()["token"]
        assert "token_hash" not in key.json()
        allowed = client.get(
            f"/api/v1/employees/credentials/whoami?employee_id={employee_id}",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert allowed.status_code == 200, allowed.text
        denied = client.get(
            f"/api/v1/employees/credentials/whoami?employee_id={copy_id}",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert denied.status_code == 403

        revoked = client.delete(f"/api/v1/employees/credentials/{key.json()['id']}", headers=owner)
        assert revoked.status_code == 200
        after = client.get(
            f"/api/v1/employees/credentials/whoami?employee_id={employee_id}",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert after.status_code == 401

        inbound = {
            "event_id": f"evt_{suffix}",
            "employee_id": employee_id,
            "user_id": owner["X-User-ID"],
            "message": "你好",
        }
        first = client.post("/api/v1/feishu/inbound", json=inbound)
        assert first.status_code == 200, first.text
        second = client.post("/api/v1/feishu/inbound", json=inbound)
        assert second.status_code == 200
        assert second.json()["duplicate"] is True
        assert second.json()["run_id"] == first.json()["run_id"]

        query = client.post(
            f"/api/v1/employees/{employee_id}/knowledge/query",
            headers=owner,
            json={
                "purpose": "answer",
                "hits": [
                    {"collection": "kb-main", "title": "制度", "content": "原文", "version": "old"},
                    {"collection": "other", "content": "不该出现"},
                ],
            },
        )
        assert query.status_code == 200, query.text
        assert query.json()["excerpts"][0]["label"] == "[1]"
        assert len(query.json()["excerpts"]) == 1
        assert query.json()["excerpts"][0]["version"] == "3"

        detail = client.get(f"/api/v1/runs/{draft.json()['run_id']}")
        assert detail.status_code == 200
        kinds = [line["kind"] for line in detail.json()["trace"]]
        assert "skill" in kinds
        assert "knowledge" in kinds

        step = client.post(
            "/api/v1/employees/confirmations",
            json={"subject_type": "govern", "subject_id": "plan-1", "plan": {"keep": True}},
        )
        assert step.status_code == 200, step.text
        acted = client.post(
            f"/api/v1/employees/confirmations/{step.json()['id']}/act",
            headers=owner,
            json={"action": "confirm", "note": "通过"},
        )
        assert acted.json()["changed"] is True
        again = client.post(
            f"/api/v1/employees/confirmations/{step.json()['id']}/act",
            headers=owner,
            json={"action": "reject"},
        )
        assert again.json()["changed"] is False
        assert again.json()["plan"] == {"keep": True}
        assert again.json()["status"] == "confirmed"

        linked = client.post(
            "/api/v1/feishu/bind-user",
            json={"channel_user_id": f"ou_{suffix}", "local_user_id": owner["X-User-ID"]},
        )
        assert linked.status_code == 200
        via_channel = client.post(
            "/api/v1/feishu/inbound",
            json={
                "event_id": f"evt_link_{suffix}",
                "employee_id": employee_id,
                "user_id": f"ou_{suffix}",
                "message": "绑定后的消息",
            },
        )
        assert via_channel.status_code == 200, via_channel.text
        retry = client.post(
            "/api/v1/feishu/outbound-retry",
            json={"event_id": f"evt_link_{suffix}", "error": "timeout"},
        )
        assert retry.status_code == 200
        assert retry.json()["attempts"] == 1
        assert retry.json()["retry"] is True
