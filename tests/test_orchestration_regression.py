"""编排任务入口、工坊确定性执行、项目绑定与输出详情的回归测试。"""

import json
import uuid

import pytest
from fastapi.testclient import TestClient

from backend import app


def test_tasks_execute_unknown_project_id_returns_404():
    with TestClient(app) as client:
        r = client.post(
            "/api/v1/tasks/execute",
            json={
                "entrypoint": "chat",
                "project_id": str(uuid.uuid4()),
                "user_message": "hi",
                "stream": False,
            },
        )
    assert r.status_code == 404
    assert "项目" in r.json().get("detail", "")


def test_orchestration_preview_carries_scenario_preset():
    with TestClient(app) as client:
        pr = client.post("/api/v1/projects/", json={"name": "编排回归项目"}).json()
        pid = pr["id"]
        r = client.post(
            f"/api/v1/projects/{pid}/orchestration/preview",
            json={
                "scenario_id": "tech-doc",
                "user_message": "预览",
                "scenario_preset_instructions": "详细人设与风格：必须专业、引用规范。",
                "scenario_opening_hint": "请从背景写起。",
            },
        )
    assert r.status_code == 200, r.text
    payload = r.json()["payload"]
    scenario = payload.get("scenario") or {}
    assert scenario.get("preset_instructions") == "详细人设与风格：必须专业、引用规范。"
    assert scenario.get("opening_hint") == "请从背景写起。"


def test_workshop_execute_calls_configured_skill_not_agent_only():
    with TestClient(app) as client:
        iname = "hello_skill"
        client.delete(f"/api/v1/skills/{iname}")
        ins = client.post(
            "/api/v1/skills/",
            json={"name": iname, "description": "t", "source": "local"},
        )
        assert ins.status_code == 200, ins.text

        r = client.post(
            "/api/v1/tasks/execute",
            json={
                "entrypoint": "workshop",
                "user_message": json.dumps({"name": "RegressionUser", "title": "t"}),
                "stream": False,
                "overrides": {"skills": {"allowed": [iname]}},
            },
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert iname in (body.get("used_skills") or [])
    assert "RegressionUser" in body.get("content", "")
    assert body.get("content", "").count("hello_skill") >= 1 or "Hello" in body.get("content", "")


def test_project_output_detail_returns_full_content():
    with TestClient(app) as client:
        pr = client.post("/api/v1/projects/", json={"name": "输出全文项目"}).json()
        pid = pr["id"]
        iname = "hello_skill"
        client.delete(f"/api/v1/skills/{iname}")
        assert client.post(
            "/api/v1/skills/",
            json={"name": iname, "description": "t", "source": "local"},
        ).status_code == 200

        ex = client.post(
            "/api/v1/tasks/execute",
            json={
                "entrypoint": "workshop",
                "project_id": pid,
                "user_message": json.dumps({"name": "DocUser"}),
                "stream": False,
                "overrides": {"skills": {"allowed": [iname]}},
            },
        )
        assert ex.status_code == 200, ex.text
        out_id = ex.json().get("output_id")
        assert out_id, "应有 output_id（工坊在项目下落库）"

        lst = client.get(f"/api/v1/projects/{pid}/outputs")
        assert lst.status_code == 200
        rows = lst.json()
        assert any(o["id"] == out_id for o in rows)

        detail = client.get(f"/api/v1/projects/{pid}/outputs/{out_id}")
        assert detail.status_code == 200
        full = detail.json().get("content") or ""
        assert len(full) > 30
        assert "DocUser" in full


def test_orchestration_preview_second_call_without_preset_has_no_stale_preset():
    """模拟「新建普通会话」后再次预览：不传 preset 时不应带上一次的编排人设（后端请求体须自洽）。"""
    with TestClient(app) as client:
        pr = client.post("/api/v1/projects/", json={"name": "编排会话隔离占位"}).json()
        pid = pr["id"]
        mark = "STALE_SCENARIO_MARK_991"
        r1 = client.post(
            f"/api/v1/projects/{pid}/orchestration/preview",
            json={"scenario_preset_instructions": mark, "user_message": "a"},
        )
        assert r1.status_code == 200, r1.text
        assert mark in json.dumps(r1.json()["payload"], ensure_ascii=False)

        r2 = client.post(
            f"/api/v1/projects/{pid}/orchestration/preview",
            json={"user_message": "b"},
        )
    assert r2.status_code == 200, r2.text
    scen = (r2.json().get("payload") or {}).get("scenario") or {}
    pin = scen.get("preset_instructions")
    assert pin is None or mark not in str(pin)
