"""压测画像：用户会话隔离，以及 Hermes 热路径配置。"""

from pathlib import Path

import yaml

from backend.services.user_identity import (
    HERMES_SESSION_HEADER,
    apply_hermes_session_header,
    derive_hermes_session_id,
)

ROOT = Path(__file__).resolve().parents[1]


def test_session_id_splits_users_and_stays_stable():
    same_user = derive_hermes_session_id("employee-a", "co-create")
    other_user = derive_hermes_session_id("employee-b", "co-create")
    other_scope = derive_hermes_session_id("employee-a", "room:1")

    assert same_user == derive_hermes_session_id("employee-a", "co-create")
    assert same_user != other_user
    assert same_user != other_scope
    assert same_user.startswith("sess-")
    assert len(same_user) == len("sess-") + 16


def test_session_header_is_attached():
    headers: dict[str, str] = {}
    session_id = apply_hermes_session_header(headers, "employee-a", "scenario-1")
    assert headers[HERMES_SESSION_HEADER] == session_id


def test_deploy_config_matches_pressure_profile():
    data = yaml.safe_load((ROOT / "deploy/hermes-agent/config.yaml").read_text(encoding="utf-8"))
    server = data["mcp_servers"]["tphermes"]
    assert server["connect_timeout"] == 5
    assert server["tools"]["include"] == [
        "kb_query",
        "kb_list_collections",
        "kb_get_entry",
        "workshop_list_skills",
        "workshop_get_skill_info",
        "workshop_generate",
        "workshop_generate_from_kb",
        "tavily_search",
        "tavily_extract",
    ]
    assert data["gateway"]["api_server"]["max_concurrent_runs"] == 32
    disabled = set(data["agent"]["disabled_toolsets"])
    assert {"web", "file", "skills", "code_execution"} <= disabled
    assert "terminal" not in disabled
