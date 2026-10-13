"""七个工作台 CLI：演示数据、关闭后不被环境变量打开、配置可保存。"""

import json

from fastapi.testclient import TestClient

from backend import app
from tpdhermes.capabilities import MODULES, invoke, module_enabled, public_config, save_document
from tpdhermes.cli import main


def _isolate(monkeypatch, tmp_path):
    monkeypatch.setenv("TPDHERMES_CLI_CONFIG", str(tmp_path / "cli-modules.json"))
    monkeypatch.delenv("HERMES_API_URL", raising=False)
    monkeypatch.delenv("AI_MOCK_MODE", raising=False)


def test_demo_covers_every_workbench(monkeypatch, tmp_path, capsys):
    _isolate(monkeypatch, tmp_path)
    for item in MODULES:
        for action in item["actions"]:
            code = main([item["command"], action, "--demo", "--format", "json"])
            captured = capsys.readouterr()
            payload = json.loads(captured.out)
            assert code == 0, f"{item['id']} {action}"
            assert payload["module"] == item["id"]
            assert payload["action"] == action
            assert payload["data_source"] == "demo"
            assert payload["count"] >= 1


def test_disabled_action_stays_disabled(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)
    save_document({"modules": {"project": {"actions": {"members": False}}}})
    monkeypatch.setenv("AI_MOCK_MODE", "true")
    code, payload = invoke("project", "members", {"project": "p-1"}, demo_flag=True)
    assert code == 1
    assert "项目成员" in payload["warnings"][0]
    listed, _ = invoke("project", "list", demo_flag=True)
    assert listed == 0
    view = public_config()
    project = next(row for row in view["modules"] if row["id"] == "project")
    members = next(action for action in project["actions"] if action["id"] == "members")
    assert members["enabled"] is False


def test_disabled_module_stays_disabled(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)
    save_document({"modules": {"kb": {"enabled": False, "demo": False}}})
    monkeypatch.setenv("AI_MOCK_MODE", "true")
    assert module_enabled("kb") is False
    code, payload = invoke("kb", "health", demo_flag=True)
    assert code == 1
    assert payload["warnings"]
    view = public_config()
    kb = next(row for row in view["modules"] if row["id"] == "kb")
    assert kb["enabled"] is False
    assert kb["demo"] is False


def test_agent_token_gates_cli_commands(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)
    monkeypatch.delenv("HERMES_CLI_TOKEN", raising=False)
    secret = "agent-cli-token-1"

    def _boom(*_args, **_kwargs):
        raise AssertionError("未设置 Token 时不应访问上游")

    blocked_code, blocked = invoke("project", "list", transport=_boom)
    assert blocked_code == 1
    assert "接入 Token" in blocked["warnings"][0]

    with TestClient(app) as client:
        rejected = client.put("/api/v1/system/cli", json={"token": "too-short"})
        assert rejected.status_code == 400
        pending = client.post("/api/v1/system/cli/token/verify", json={"token": secret})
        assert pending.status_code == 200
        assert pending.json()["ok"] is True
        assert pending.json()["can_execute"] is False
        saved = client.put("/api/v1/system/cli", json={"token": secret})
        assert saved.status_code == 200
        body = saved.json()
        assert body["token_set"] is True
        assert body["token_source"] == "saved"
        assert secret not in saved.text
        matched = client.post("/api/v1/system/cli/token/verify", json={"token": secret})
        assert matched.json()["can_execute"] is True
        assert secret not in matched.text
        missing = client.get("/api/v1/system/cli", headers={"X-TPDHermes-Client": "cli"})
        assert missing.status_code == 401
        wrong = client.get(
            "/api/v1/system/cli",
            headers={"X-TPDHermes-Client": "cli", "X-TPDHermes-Agent-Token": "another-agent-token"},
        )
        assert wrong.status_code == 401
        allowed = client.get(
            "/api/v1/system/cli",
            headers={"X-TPDHermes-Client": "cli", "X-TPDHermes-Agent-Token": secret},
        )
        assert allowed.status_code == 200
        assert secret not in allowed.text
        web = client.get("/api/v1/system/cli")
        assert web.status_code == 200

    monkeypatch.setenv("HERMES_CLI_TOKEN", "env-token-should-not-replace")
    view = public_config()
    assert view["token_source"] == "saved"
    assert secret not in str(view)


def test_saved_api_base_not_replaced_by_env(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)
    save_document({"api_base": "http://saved.example:8000"})
    monkeypatch.setenv("HERMES_API_URL", "http://env.example:8000")
    view = public_config()
    assert view["api_base"] == "http://saved.example:8000"
    assert view["api_base_source"] == "saved"


def test_cli_config_roundtrip(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)
    with TestClient(app) as client:
        saved = client.put(
            "/api/v1/system/cli",
            json={
                "user_id": "user_cli",
                "modules": {
                    "project": {"enabled": True, "defaults": {"project": "p-1"}},
                    "chat": {"enabled": False},
                },
            },
        )
        assert saved.status_code == 200
        body = saved.json()
        assert body["user_id"] == "user_cli"
        assert body["user_id_source"] == "saved"
        chat = next(row for row in body["modules"] if row["id"] == "chat")
        project = next(row for row in body["modules"] if row["id"] == "project")
        assert chat["enabled"] is False
        assert project["defaults"]["project"] == "p-1"
        again = client.get("/api/v1/system/cli")
        assert again.json()["modules"] == body["modules"]
