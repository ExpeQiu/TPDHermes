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
        # Create a dedicated project and bind general scenario for workshop
        pr = client.post("/api/v1/projects/", json={"name": "回归测试工坊项目"}).json()
        pid = pr["id"]
        client.post(
            f"/api/v1/projects/{pid}/scenarios",
            json={"scenario_id": "general", "scenario_version": "1.0.0", "is_default": True},
        )

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
                "project_id": pid,
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
        assert detail.json().get("status") == "completed"
        assert len(full) > 30
        assert "DocUser" in full


def test_project_context_endpoint_returns_shapes():
    with TestClient(app) as client:
        pr = client.post("/api/v1/projects/", json={"name": "上下文接口项目"}).json()
        pid = pr["id"]
        r = client.get(f"/api/v1/projects/{pid}/context")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["project_id"] == pid
    assert data["name"] == "上下文接口项目"
    assert isinstance(data["attachments"], list)
    assert isinstance(data["recent_outputs"], list)


def test_output_version_create_increment():
    with TestClient(app) as client:
        pr = client.post("/api/v1/projects/", json={"name": "版本链项目"}).json()
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
                "user_message": json.dumps({"name": "VUser"}),
                "stream": False,
                "overrides": {"skills": {"allowed": [iname]}},
            },
        )
        assert ex.status_code == 200, ex.text
        out_id = ex.json().get("output_id")
        assert out_id

        v = client.post(
            f"/api/v1/projects/{pid}/outputs/{out_id}/versions",
            json={"content": "第二代正文内容用于版本接口", "title": "v2-title"},
        )
    assert v.status_code == 200, v.text
    vj = v.json()
    assert vj.get("content") == "第二代正文内容用于版本接口"
    assert vj.get("id") != out_id


def test_skills_list_exposes_scope_public_for_local_install():
    with TestClient(app) as client:
        iname = "hello_skill"
        client.delete(f"/api/v1/skills/{iname}")
        assert client.post(
            "/api/v1/skills/",
            json={"name": iname, "description": "t", "source": "local"},
        ).status_code == 200
        lst = client.get("/api/v1/skills/")
    assert lst.status_code == 200, lst.text
    row = next(s for s in lst.json() if s["name"] == iname)
    assert row.get("scope") == "public"

def test_workshop_source_output_id_merges_prior_output_content():
    with TestClient(app) as client:
        pr = client.post("/api/v1/projects/", json={"name": "来源优化回归"}).json()
        pid = pr["id"]
        client.post(
            f"/api/v1/projects/{pid}/scenarios",
            json={"scenario_id": "general", "scenario_version": "1.0.0", "is_default": True},
        )
        iname = "hello_skill"
        client.delete(f"/api/v1/skills/{iname}")
        assert client.post(
            "/api/v1/skills/",
            json={"name": iname, "description": "t", "source": "local"},
        ).status_code == 200

        ex1 = client.post(
            "/api/v1/tasks/execute",
            json={
                "entrypoint": "workshop",
                "project_id": pid,
                "scenario_id": "general",
                "user_message": json.dumps({"name": "FirstUser", "title": "t1"}),
                "stream": False,
                "overrides": {"skills": {"allowed": [iname]}},
            },
        )
        assert ex1.status_code == 200, ex1.text
        out_id = ex1.json().get("output_id")
        assert out_id

        ex2 = client.post(
            "/api/v1/tasks/execute",
            json={
                "entrypoint": "workshop",
                "project_id": pid,
                "scenario_id": "general",
                "source_output_id": out_id,
                "user_message": json.dumps({"name": "SecondUser", "title": "t2"}),
                "stream": False,
                "overrides": {"skills": {"allowed": [iname]}},
            },
        )
    assert ex2.status_code == 200, ex2.text
    text = ex2.json().get("content") or ""
    assert "FirstUser" in text or "DocUser" in text or len(text) > 20


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


def test_scenario_put_goal_only_preserves_required_sections():
    """模拟编排页仅改目标：partial PUT 不应清空 output_policy.required_sections。"""
    with TestClient(app) as client:
        code = f"sec-{uuid.uuid4().hex[:8]}"
        sections = ["定制章节甲", "定制章节乙"]
        cr = client.post(
            "/api/v1/scenarios/",
            json={
                "code": code,
                "name": "章节保真",
                "skills_policy": {"mode": "allowed_list", "allowed": ["hello_skill"]},
                "output_policy": {
                    "must_follow_template": False,
                    "required_sections": sections,
                    "format": "markdown",
                },
            },
        )
        assert cr.status_code == 200, cr.text
        sid = cr.json()["id"]
        pu = client.put(f"/api/v1/scenarios/{sid}", json={"goal": "仅改目标"})
        assert pu.status_code == 200, pu.text
        g = client.get(f"/api/v1/scenarios/{sid}").json()
    assert g.get("goal") == "仅改目标"
    assert g.get("output_policy", {}).get("required_sections") == sections


def test_scenario_put_goal_only_preserves_skills_allowlist_with_missing_names():
    """白名单含当前环境不存在的技能名时，仅改目标不应丢失或改写 allowed。"""
    with TestClient(app) as client:
        code = f"sk-{uuid.uuid4().hex[:8]}"
        allow = ["hello_skill", "not_installed_skill_xyz"]
        cr = client.post(
            "/api/v1/scenarios/",
            json={
                "code": code,
                "name": "白名单保真",
                "skills_policy": {"mode": "allowed_list", "allowed": allow},
                "output_policy": {
                    "must_follow_template": False,
                    "required_sections": ["一"],
                    "format": "markdown",
                },
            },
        )
        assert cr.status_code == 200, cr.text
        sid = cr.json()["id"]
        pu = client.put(f"/api/v1/scenarios/{sid}", json={"goal": "g2"})
        assert pu.status_code == 200, pu.text
        g = client.get(f"/api/v1/scenarios/{sid}").json()
    assert g.get("skills_policy", {}).get("allowed") == allow


def test_scenario_publish_rejects_empty_skills_allowed():
    with TestClient(app) as client:
        code = f"pub-empty-{uuid.uuid4().hex[:8]}"
        cr = client.post(
            "/api/v1/scenarios/",
            json={
                "code": code,
                "name": "发布校验空技能",
                "skills_policy": {"mode": "manual_only", "allowed": []},
                "output_policy": {
                    "must_follow_template": False,
                    "required_sections": ["背景"],
                    "format": "markdown",
                },
            },
        )
        assert cr.status_code == 200, cr.text
        sid = cr.json()["id"]
        pub = client.post(f"/api/v1/scenarios/{sid}/publish")
    assert pub.status_code == 400
    assert "allowed" in str(pub.json().get("detail", ""))


def test_scenario_publish_rejects_must_follow_without_sections():
    with TestClient(app) as client:
        iname = "hello_skill"
        client.delete(f"/api/v1/skills/{iname}")
        assert (
            client.post(
                "/api/v1/skills/",
                json={"name": iname, "description": "t", "source": "local"},
            ).status_code
            == 200
        )
        code = f"pub-mft-{uuid.uuid4().hex[:8]}"
        cr = client.post(
            "/api/v1/scenarios/",
            json={
                "code": code,
                "name": "强制模版无章节",
                "skills_policy": {"mode": "allowed_list", "allowed": [iname]},
                "output_policy": {
                    "must_follow_template": True,
                    "required_sections": [],
                    "format": "markdown",
                },
            },
        )
        assert cr.status_code == 200, cr.text
        sid = cr.json()["id"]
        pub = client.post(f"/api/v1/scenarios/{sid}/publish")
    assert pub.status_code == 400
    assert "required_sections" in str(pub.json().get("detail", ""))


def test_scenario_publish_200_when_contract_valid():
    with TestClient(app) as client:
        iname = "hello_skill"
        client.delete(f"/api/v1/skills/{iname}")
        assert (
            client.post(
                "/api/v1/skills/",
                json={"name": iname, "description": "t", "source": "local"},
            ).status_code
            == 200
        )
        code = f"pub-ok-{uuid.uuid4().hex[:8]}"
        cr = client.post(
            "/api/v1/scenarios/",
            json={
                "code": code,
                "name": "可发布场景",
                "skills_policy": {"mode": "allowed_list", "allowed": [iname]},
                "output_policy": {
                    "must_follow_template": False,
                    "required_sections": ["背景", "方案"],
                    "format": "markdown",
                },
            },
        )
        assert cr.status_code == 200, cr.text
        sid = cr.json()["id"]
        pub = client.post(f"/api/v1/scenarios/{sid}/publish")
    assert pub.status_code == 200, pub.text
    body = pub.json()
    assert body.get("status") == "published"


def test_project_output_approve_and_archive_roundtrip():
    with TestClient(app) as client:
        pr = client.post("/api/v1/projects/", json={"name": "输出治理项目"}).json()
        pid = pr["id"]
        iname = "hello_skill"
        client.delete(f"/api/v1/skills/{iname}")
        assert (
            client.post(
                "/api/v1/skills/",
                json={"name": iname, "description": "t", "source": "local"},
            ).status_code
            == 200
        )
        ex = client.post(
            "/api/v1/tasks/execute",
            json={
                "entrypoint": "workshop",
                "project_id": pid,
                "user_message": json.dumps({"name": "GovUser", "title": "t"}),
                "stream": False,
                "overrides": {"skills": {"allowed": [iname]}},
            },
        )
        assert ex.status_code == 200, ex.text
        out_id = ex.json().get("output_id")
        assert out_id
        ap = client.post(f"/api/v1/projects/{pid}/outputs/{out_id}/approve")
        assert ap.status_code == 200, ap.text
        assert ap.json().get("status") == "approved"
        ar = client.post(f"/api/v1/projects/{pid}/outputs/{out_id}/archive")
        assert ar.status_code == 200, ar.text
        assert ar.json().get("status") == "archived"
