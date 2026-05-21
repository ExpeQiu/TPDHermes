import tempfile
from pathlib import Path

import pytest

from backend.services import mcp_registry


@pytest.fixture
def temp_config(monkeypatch):
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "config.yaml"
        path.write_text(
            """
mcp_servers:
  tphermes:
    url: http://127.0.0.1:8801/mcp
    enabled: true
    tools:
      include:
        - kb_query
        - workshop_generate
""".strip(),
            encoding="utf-8",
        )
        monkeypatch.setenv("HERMES_AGENT_CONFIG_PATH", str(path))
        yield path


def test_list_servers_reads_config(temp_config):
    data = mcp_registry.list_servers()
    assert data["config_exists"] is True
    assert len(data["servers"]) == 1
    server = data["servers"][0]
    assert server["name"] == "tphermes"
    assert server["enabled"] is True
    assert "kb_query" in server["tools"]["enabled"]


def test_update_server_tools_include(temp_config):
    updated = mcp_registry.update_server("tphermes", tools_include=["project_list", "project_get"])
    assert updated["tools"]["enabled"] == ["project_list", "project_get"]
    reloaded = mcp_registry.list_servers()["servers"][0]
    assert reloaded["tools"]["enabled"] == ["project_list", "project_get"]


def test_update_server_enabled(temp_config):
    updated = mcp_registry.update_server("tphermes", enabled=False)
    assert updated["enabled"] is False
