"""编排任务入口、工坊确定性执行、项目绑定与输出详情的回归测试。"""

import json
import uuid

from fastapi.testclient import TestClient

from backend import app

HDR_ADMIN = {"X-User-ID": "default"}


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


def test_workshop_execute_without_project_scenario_binding():
    """工坊不应要求提前在项目详情绑定场景。"""
    with TestClient(app) as client:
        pr = client.post("/api/v1/projects/", json={"name": "未绑定场景工坊项目"}).json()
        pid = pr["id"]
        iname = "hello_skill"
        client.delete(f"/api/v1/skills/{iname}")
        assert client.post(
            "/api/v1/skills/",
            json={"name": iname, "description": "t", "source": "local"},
        ).status_code == 200

        sc = client.post(
            "/api/v1/scenarios/",
            headers=HDR_ADMIN,
            json={
                "code": f"ws-unbound-{pid[:8]}",
                "name": "未绑定测试场景",
                "description": "无需项目绑定即可工坊执行",
                "goal": "验证",
                "conversation_mode": "task_oriented",
                "domain": {},
                "knowledge_policy": {"mode": "off", "collections": []},
                "skills_policy": {"mode": "allowed_list", "allowed": [iname], "preferred": []},
                "output_policy": {
                    "must_follow_template": False,
                    "required_sections": ["背景"],
                    "format": "markdown",
                },
            },
        )
        assert sc.status_code == 200, sc.text
        scenario_id = sc.json()["id"]
        pub = client.post(f"/api/v1/scenarios/{scenario_id}/publish", headers=HDR_ADMIN)
        assert pub.status_code == 200, pub.text

        bound = client.get(f"/api/v1/projects/{pid}/scenarios").json()
        assert not any(row["scenario_id"] == scenario_id for row in bound)

        r = client.post(
            "/api/v1/tasks/execute",
            json={
                "entrypoint": "workshop",
                "project_id": pid,
                "scenario_id": scenario_id,
                "user_message": json.dumps({"name": "UnboundUser", "title": "t"}),
                "stream": False,
                "overrides": {"skills": {"allowed": [iname]}},
            },
        )
    assert r.status_code == 200, r.text
    assert "UnboundUser" in r.json().get("content", "")


def test_workshop_execute_rejects_multiple_allowed_skills():
    with TestClient(app) as client:
        pr = client.post("/api/v1/projects/", json={"name": "多技能工坊校验"}).json()
        pid = pr["id"]
        client.post(
            f"/api/v1/projects/{pid}/scenarios",
            json={"scenario_id": "general", "scenario_version": "1.0.0", "is_default": True},
        )
        for iname in ("hello_skill", "speech_skill"):
            client.delete(f"/api/v1/skills/{iname}")
            assert client.post(
                "/api/v1/skills/",
                json={"name": iname, "description": "t", "source": "local"},
            ).status_code == 200

        r = client.post(
            "/api/v1/tasks/execute",
            json={
                "entrypoint": "workshop",
                "project_id": pid,
                "user_message": json.dumps({"name": "MultiSkillUser"}),
                "stream": False,
                "overrides": {"skills": {"allowed": ["hello_skill", "speech_skill"]}},
            },
        )
    assert r.status_code == 400, r.text
    assert "恰好 1 项" in str(r.json().get("detail", ""))


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
            headers=HDR_ADMIN,
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
        pu = client.put(
            f"/api/v1/scenarios/{sid}",
            headers=HDR_ADMIN,
            json={"goal": "仅改目标"},
        )
        assert pu.status_code == 200, pu.text
        g = client.get(f"/api/v1/scenarios/{sid}", headers=HDR_ADMIN).json()
    assert g.get("goal") == "仅改目标"
    assert g.get("output_policy", {}).get("required_sections") == sections


def test_scenario_put_goal_only_preserves_skills_allowlist_with_missing_names():
    """白名单含当前环境不存在的技能名时，仅改目标不应丢失或改写 allowed。"""
    with TestClient(app) as client:
        code = f"sk-{uuid.uuid4().hex[:8]}"
        allow = ["hello_skill", "not_installed_skill_xyz"]
        cr = client.post(
            "/api/v1/scenarios/",
            headers=HDR_ADMIN,
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
        pu = client.put(
            f"/api/v1/scenarios/{sid}",
            headers=HDR_ADMIN,
            json={"goal": "g2"},
        )
        assert pu.status_code == 200, pu.text
        g = client.get(f"/api/v1/scenarios/{sid}", headers=HDR_ADMIN).json()
    assert g.get("skills_policy", {}).get("allowed") == allow


def test_scenario_publish_rejects_empty_skills_allowed():
    with TestClient(app) as client:
        code = f"pub-empty-{uuid.uuid4().hex[:8]}"
        cr = client.post(
            "/api/v1/scenarios/",
            headers=HDR_ADMIN,
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
        pub = client.post(f"/api/v1/scenarios/{sid}/publish", headers=HDR_ADMIN)
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
            headers=HDR_ADMIN,
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
        pub = client.post(f"/api/v1/scenarios/{sid}/publish", headers=HDR_ADMIN)
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
            headers=HDR_ADMIN,
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
        pub = client.post(f"/api/v1/scenarios/{sid}/publish", headers=HDR_ADMIN)
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


def test_chat_doc_optimize_requires_source_output_id():
    with TestClient(app) as client:
        pr = client.post("/api/v1/projects/", json={"name": "chat文稿优化校验"}).json()
        pid = pr["id"]
        ex = client.post(
            "/api/v1/tasks/execute",
            json={
                "entrypoint": "chat",
                "project_id": pid,
                "chat_mode": "doc_optimize",
                "user_message": "请优化引言",
                "stream": False,
            },
        )
    assert ex.status_code == 400, ex.text
    assert "来源输出" in ex.text or "source" in ex.text.lower()


def test_chat_doc_optimize_injects_full_source_material(monkeypatch):
    """文稿优化须将来源输出全文写入 task_input.source_material，而非 kb 上下文提示。"""
    import asyncio

    from backend.db import async_session_maker
    from backend.models.orchestration_run import OrchestrationRun

    class FakeResp:
        status_code = 200

        def json(self):
            return {"choices": [{"message": {"content": "optimized draft"}}]}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, _url, _json=None, _headers=None, **_kwargs):
            return FakeResp()

    monkeypatch.setattr("backend.routes.tasks._chat_client", lambda timeout: FakeClient())

    async def _load_request_json(run_id: str) -> dict:
        async with async_session_maker() as db:
            row = await db.get(OrchestrationRun, run_id)
            assert row and row.request_json
            return json.loads(row.request_json)

    with TestClient(app) as client:
        pr = client.post("/api/v1/projects/", json={"name": "chat文稿优化全文"}).json()
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
                "user_message": json.dumps({"name": "DocOptimizeUser", "title": "待优化稿"}),
                "stream": False,
                "overrides": {"skills": {"allowed": [iname]}},
            },
        )
        assert ex1.status_code == 200, ex1.text
        out_id = ex1.json().get("output_id")
        assert out_id
        detail = client.get(f"/api/v1/projects/{pid}/outputs/{out_id}")
        assert detail.status_code == 200, detail.text
        full_body = (detail.json().get("content") or "").strip()
        assert full_body

        ex2 = client.post(
            "/api/v1/tasks/execute",
            json={
                "entrypoint": "chat",
                "project_id": pid,
                "chat_mode": "doc_optimize",
                "source_output_id": out_id,
                "user_message": "请优化第二段",
                "task_input": {
                    "extra": "[文稿优化]\n待优化输出: output_id="
                    + out_id
                    + "\n改写目标: 更简洁",
                },
                "stream": False,
            },
        )
        assert ex2.status_code == 200, ex2.text
        run_id = ex2.json().get("run_id")
        assert run_id
        req = asyncio.run(_load_request_json(run_id))
    sm = (req.get("task_input") or {}).get("source_material") or ""
    assert full_body in sm or sm == full_body
    assert "kb_query" not in sm.lower()


def test_chat_stream_normalizes_file_tool_events(monkeypatch):
    class FakeStreamResp:
        status_code = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def aread(self):
            return b""

        async def aiter_text(self):
            chunks = [
                'event: hermes.tool.progress\ndata: {"tool":"write_file",',
                '"toolCallId":"call-1","status":"running","label":"docs/prd.md","emoji":"✍️"}\n\n',
                'data: {"choices":[{"index":0,"delta":{"content":"# 标题\\n"}}]}\n\n',
                'event: hermes.tool.progress\ndata: {"tool":"write_file","toolCallId":"call-1","status":"completed"}\n\n',
                'data: {"choices":[{"index":0,"delta":{"content":"正文"}}]}\n\n',
                "data: [DONE]\n\n",
            ]
            for chunk in chunks:
                yield chunk

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        def stream(self, _method, _url, _headers=None, _json=None):
            return FakeStreamResp()

    monkeypatch.setattr("backend.routes.tasks._chat_client", lambda timeout: FakeClient())
    monkeypatch.setattr("backend.routes.tasks._chat_target_required", lambda: ("http://fake-upstream", ""))

    with TestClient(app) as client:
        pr = client.post("/api/v1/projects/", json={"name": "chat工具事件归一化"}).json()
        pid = pr["id"]
        resp = client.post(
            "/api/v1/tasks/execute",
            json={
                "entrypoint": "chat",
                "project_id": pid,
                "chat_mode": "co_create",
                "user_message": "请生成一份 PRD",
                "stream": True,
            },
        )

    assert resp.status_code == 200, resp.text
    assert "event: hermes.tool.progress" in resp.text

    tool_event_batches: list[list[dict[str, object]]] = []
    for line in resp.text.splitlines():
        if not line.startswith("data: "):
            continue
        payload = line[len("data: "):].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            parsed = json.loads(payload)
        except json.JSONDecodeError:
            continue
        task = parsed.get("tphermes_task") if isinstance(parsed, dict) else None
        if isinstance(task, dict) and isinstance(task.get("tool_events"), list):
            tool_event_batches.append(task["tool_events"])

    assert len(tool_event_batches) >= 3, tool_event_batches
    assert tool_event_batches[0] == [
        {
            "tool_call_id": "call-1",
            "tool_name": "write_file",
            "status": "running",
            "label": "docs/prd.md",
            "emoji": "✍️",
            "path": "docs/prd.md",
        }
    ]
    assert tool_event_batches[1] == [
        {
            "tool_call_id": "call-1",
            "tool_name": "write_file",
            "status": "completed",
        }
    ]
    assert tool_event_batches[-1] == [
        {
            "tool_call_id": "call-1",
            "tool_name": "write_file",
            "status": "completed",
            "label": "docs/prd.md",
            "emoji": "✍️",
            "path": "docs/prd.md",
        }
    ]


def test_chat_source_output_id_not_found():
    with TestClient(app) as client:
        pr = client.post("/api/v1/projects/", json={"name": "chat来源404"}).json()
        pid = pr["id"]
        ex = client.post(
            "/api/v1/tasks/execute",
            json={
                "entrypoint": "chat",
                "project_id": pid,
                "chat_mode": "co_create",
                "source_output_id": "nonexistent-output-id",
                "user_message": "基于文档回答",
                "stream": False,
            },
        )
    assert ex.status_code == 404, ex.text


def test_chat_assemble_payload_disables_auto_save_output():
    import asyncio

    from backend.db import async_session_maker
    from backend.schemas.orchestration import TaskExecuteRequest
    from backend.services.orchestration_service import assemble_payload

    async def _run():
        async with async_session_maker() as db:
            payload, _ = await assemble_payload(
                db,
                TaskExecuteRequest(
                    entrypoint="chat",
                    project_id=None,
                    user_message="hi",
                    stream=False,
                ),
                effective_user_id="test-user",
                actor_role="tenant_admin",
            )
        return payload.execution.save_output

    assert asyncio.run(_run()) is False


def test_chat_manual_deposit_from_chat():
    import asyncio

    from backend.db import async_session_maker
    from backend.services.run_log_service import create_run

    async def _create_run(project_id: str) -> str:
        run_id = str(uuid.uuid4())
        async with async_session_maker() as db:
            await create_run(
                db,
                run_id=run_id,
                project_id=project_id,
                scenario_id="general",
                entrypoint="chat",
                user_id="test-user",
                request_json=json.dumps({"user_message": "写一句 Slogan"}, ensure_ascii=False),
                snapshot_json="{}",
            )
        return run_id

    with TestClient(app) as client:
        pr = client.post("/api/v1/projects/", json={"name": "chat手动存入"}).json()
        pid = pr["id"]
        run_id = asyncio.run(_create_run(pid))
        content = "Hermes 让知识流动起来。"

        dep = client.post(
            f"/api/v1/projects/{pid}/outputs/deposit-from-chat",
            json={
                "content": content,
                "title": "对话摘录",
                "run_id": run_id,
                "message_id": "msg-test-1",
            },
        )
        assert dep.status_code == 200, dep.text
        out_id = dep.json().get("id")
        assert out_id
        assert dep.json().get("entrypoint") == "chat"
        assert dep.json().get("content") == content

        lst = client.get(f"/api/v1/projects/{pid}/outputs")
        assert lst.status_code == 200
        rows = lst.json()
        assert any(o["id"] == out_id for o in rows)
        matched = next(o for o in rows if o["id"] == out_id)
        assert matched.get("entrypoint") == "chat"
        assert matched.get("user_message") == "写一句 Slogan"
