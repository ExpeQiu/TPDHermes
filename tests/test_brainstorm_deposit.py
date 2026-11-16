"""圆桌结果确认后才写入项目，并记下结束原因。"""

from uuid import uuid4

from fastapi.testclient import TestClient

from backend import app


def test_deposit_keeps_stop_reason_in_summary():
    headers = {"X-User-ID": f"brainstorm_{uuid4().hex[:8]}"}
    with TestClient(app) as client:
        proj = client.post(
            "/api/v1/projects",
            headers=headers,
            json={"name": "圆桌沉淀", "status": "active"},
        )
        assert proj.status_code == 200, proj.text
        project_id = proj.json()["id"]
        saved = client.post(
            f"/api/v1/projects/{project_id}/outputs/deposit-from-brainstorm",
            headers=headers,
            json={
                "content": "# 圆桌\n\n结论",
                "topic": "电池叙事",
                "ma_run_id": "ma-run-1",
                "discussion_mode": "round_robin",
                "consensus_reached": True,
                "stopped_at_round": 2,
                "stop_reason": "共识提前收束（第 2 轮）",
            },
        )
        assert saved.status_code == 200, saved.text
        body = saved.json()
        assert body["entrypoint"] == "brainstorm"
        assert body["status"] == "draft"
        assert body["summary"].startswith("共识提前收束（第 2 轮）")

        again = client.post(
            f"/api/v1/projects/{project_id}/outputs/deposit-from-brainstorm",
            headers=headers,
            json={
                "content": "# 圆桌\n\n修订结论",
                "topic": "电池叙事",
                "ma_run_id": "ma-run-1",
                "stop_reason": "共识提前收束（第 2 轮）",
            },
        )
        assert again.status_code == 200, again.text
        assert again.json()["id"] == body["id"]
        assert "修订结论" in again.json()["content"]


def test_brainstorm_roundtable_deposit_mock_e2e(monkeypatch):
    """圆桌用 Mock 返回后登记项目会话，确认沉淀才写入同一份输出。"""

    async def fake_roundtable(*_args, **_kwargs):
        return {
            "run_id": "ma-e2e",
            "mock": True,
            "consensus_reached": True,
            "discussion_mode": "round_robin",
            "stopped_at_round": 1,
            "stop_reason": "共识提前收束（第 1 轮）",
            "final_answer": "热管理叙事可以对外讲 8 分钟升温。",
        }

    monkeypatch.setattr("backend.routes.brainstorm.run_roundtable", fake_roundtable)
    headers = {"X-User-ID": f"brainstorm_{uuid4().hex[:8]}"}
    with TestClient(app) as client:
        project_id = client.post(
            "/api/v1/projects",
            headers=headers,
            json={"name": "圆桌端到端", "status": "active"},
        ).json()["id"]
        run = client.post(
            "/api/v1/brainstorm/run",
            headers=headers,
            json={
                "topic": "电池热管理怎么讲",
                "project_id": project_id,
                "demo": True,
                "wait": True,
                "rounds": 1,
                "consensus_enabled": True,
            },
        )
        assert run.status_code == 200, run.text
        assert run.json()["run_id"] == "ma-e2e"
        assert run.json()["mock"] is True
        sessions = client.get(f"/api/v1/projects/{project_id}/sessions", headers=headers)
        assert sessions.status_code == 200, sessions.text
        assert any(item["kind"] == "brainstorm" for item in sessions.json()["items"])
        saved = client.post(
            f"/api/v1/projects/{project_id}/outputs/deposit-from-brainstorm",
            headers=headers,
            json={
                "content": "# 圆桌\n\n热管理叙事可以对外讲 8 分钟升温。",
                "topic": "电池热管理怎么讲",
                "ma_run_id": "ma-e2e",
                "discussion_mode": "round_robin",
                "consensus_reached": True,
                "stopped_at_round": 1,
                "stop_reason": "共识提前收束（第 1 轮）",
            },
        )
        assert saved.status_code == 200, saved.text
        output_id = saved.json()["id"]
        detail = client.get(
            f"/api/v1/projects/{project_id}/outputs/{output_id}",
            headers=headers,
        )
        assert detail.status_code == 200, detail.text
        assert "8 分钟" in detail.json()["content"]
        assert detail.json()["entrypoint"] == "brainstorm"
