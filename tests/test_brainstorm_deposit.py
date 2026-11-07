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
