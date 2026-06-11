"""工坊 Agent 模式：tool capture 与 output 解析。"""

import json
import re
import uuid

import pytest
from fastapi.testclient import TestClient

from backend import app
from backend.services.agent_gateway import ORCHESTRATION_MARKER_BEGIN, ORCHESTRATION_MARKER_END
from backend.services.workshop_execution import extract_text_from_tool_payload, primary_text_from_capture
from backend.services.workshop_tool_capture import (
    append_workshop_tool_capture,
    load_workshop_tool_capture,
    save_workshop_tool_capture_for_context,
)
from backend.db import async_session_maker
from backend.services.run_log_service import create_run


def _run_id_from_upstream_body(body: dict) -> str | None:
    messages = body.get("messages") or []
    if not messages:
        return None
    content = messages[0].get("content") if isinstance(messages[0], dict) else None
    if not isinstance(content, str):
        return None
    m = re.search(r"tphermes_run_id=([0-9a-f-]{36})", content)
    if m:
        return m.group(1)
    begin = content.find(ORCHESTRATION_MARKER_BEGIN)
    end = content.find(ORCHESTRATION_MARKER_END)
    if begin >= 0 and end > begin:
        try:
            orch = json.loads(content[begin + len(ORCHESTRATION_MARKER_BEGIN) : end].strip())
            rid = orch.get("execution", {}).get("run_id")
            if isinstance(rid, str):
                return rid
        except json.JSONDecodeError:
            pass
    return None


@pytest.mark.asyncio
async def test_extract_text_from_workshop_generate():
    payload = {"success": True, "content": {"skill": "a4_skill", "content": "# Title"}, "skill": "a4_skill"}
    text = extract_text_from_tool_payload("workshop_generate", payload)
    assert "a4_skill" in text


@pytest.mark.asyncio
async def test_tool_capture_roundtrip():
    run_id = str(uuid.uuid4())
    async with async_session_maker() as db:
        await create_run(
            db,
            run_id=run_id,
            project_id=None,
            entrypoint="workshop",
            request_json="{}",
            snapshot_json="{}",
        )
        await append_workshop_tool_capture(
            db,
            run_id=run_id,
            tool_name="workshop_generate",
            payload={"success": True, "content": "hello capture", "skill": "hello_skill"},
            skill_name="hello_skill",
        )
        loaded = await load_workshop_tool_capture(db, run_id)
    assert primary_text_from_capture(loaded) == "hello capture"


@pytest.mark.asyncio
async def test_tool_capture_requires_explicit_run_id_and_does_not_cross_runs():
    run_id_a = str(uuid.uuid4())
    run_id_b = str(uuid.uuid4())
    project_id = str(uuid.uuid4())
    async with async_session_maker() as db:
        await create_run(
            db,
            run_id=run_id_a,
            project_id=project_id,
            entrypoint="workshop",
            user_id="capture-owner",
            request_json="{}",
            snapshot_json="{}",
        )
        await create_run(
            db,
            run_id=run_id_b,
            project_id=project_id,
            entrypoint="workshop",
            user_id="capture-owner",
            request_json="{}",
            snapshot_json="{}",
        )

    await save_workshop_tool_capture_for_context(
        {"project_id": project_id},
        "workshop_generate",
        {"success": True, "content": "should skip", "skill": "hello_skill"},
        skill_name="hello_skill",
    )
    await save_workshop_tool_capture_for_context(
        {"tphermes_run_id": run_id_a, "project_id": project_id},
        "workshop_generate",
        {"success": True, "content": "capture-a", "skill": "hello_skill"},
        skill_name="hello_skill",
    )

    async with async_session_maker() as db:
        loaded_a = await load_workshop_tool_capture(db, run_id_a)
        loaded_b = await load_workshop_tool_capture(db, run_id_b)

    assert primary_text_from_capture(loaded_a) == "capture-a"
    assert loaded_b is None


def test_workshop_agent_mode_forwards_to_upstream(monkeypatch):
    monkeypatch.setenv("WORKSHOP_EXECUTION_MODE", "agent")
    calls: list[dict] = []

    class FakeResp:
        status_code = 200

        def json(self):
            return {"choices": [{"message": {"content": "agent summary"}}]}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, url, json=None, headers=None, **_kwargs):
            calls.append({"url": url, "json": json, "headers": headers})
            return FakeResp()

    monkeypatch.setattr("backend.routes.tasks._chat_client", lambda timeout: FakeClient())

    with TestClient(app) as client:
        pr = client.post("/api/v1/projects/", json={"name": "agent模式项目"}).json()
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

        r = client.post(
            "/api/v1/tasks/execute",
            json={
                "entrypoint": "workshop",
                "project_id": pid,
                "user_message": json.dumps({"name": "AgentUser"}),
                "stream": False,
                "overrides": {"skills": {"allowed": [iname]}},
            },
        )
    assert r.status_code == 424, r.text
    assert calls, "应转发至 Hermes upstream"
    body = calls[0]["json"]
    assert body is not None
    sys_msg = body["messages"][0]["content"]
    assert "tphermes_run_id=" in sys_msg or "结果工坊强制流程" in sys_msg


def test_workshop_agent_mode_uses_tool_capture(monkeypatch):
    monkeypatch.setenv("WORKSHOP_EXECUTION_MODE", "agent")
    capture_text = "agent capture body # Title"

    class FakeResp:
        status_code = 200

        def json(self):
            return {"choices": [{"message": {"content": "agent summary only"}}]}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, _url, json=None, headers=None, **_kwargs):
            run_id = _run_id_from_upstream_body(json or {})
            assert run_id, "upstream 应携带 run_id"
            async with async_session_maker() as db:
                await append_workshop_tool_capture(
                    db,
                    run_id=run_id,
                    tool_name="workshop_generate",
                    payload={"success": True, "content": capture_text, "skill": "hello_skill"},
                    skill_name="hello_skill",
                )
            return FakeResp()

    monkeypatch.setattr("backend.routes.tasks._chat_client", lambda timeout: FakeClient())

    with TestClient(app) as client:
        pr = client.post("/api/v1/projects/", json={"name": "capture成功项目"}).json()
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

        r = client.post(
            "/api/v1/tasks/execute",
            json={
                "entrypoint": "workshop",
                "project_id": pid,
                "user_message": json.dumps({"name": "CaptureUser"}),
                "stream": False,
                "overrides": {"skills": {"allowed": [iname]}},
            },
        )

    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("tool_capture_hit") is True
    assert body.get("execution_mode") == "agent"
    assert capture_text in (body.get("content") or "")
