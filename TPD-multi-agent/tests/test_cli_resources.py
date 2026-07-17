"""CLI 资源面与 TrajectoryStore list/export 薄测。"""

from __future__ import annotations

import json
import os

from click.testing import CliRunner

from multi_agent.cli import cli
from multi_agent.sdk import create_client
from multi_agent.trajectory import TrajectoryStore


def test_store_list_runs_and_bundle(tmp_path):
    store = TrajectoryStore(tmp_path / "runs")
    assert store.list_runs() == []
    assert store.load_bundle("missing") is None

    client = create_client(demo=True, runs_dir=str(tmp_path / "runs"))
    env = client.swarm("对比供应链", max_parallel=2, pack="nev-tech")
    items = client.list_runs()
    assert any(i["id"] == env["run_id"] for i in items)
    bundle = client.export_run(env["run_id"])
    assert bundle is not None
    assert bundle["delivery"]
    assert bundle["trajectory"]


def test_sdk_resource_lists():
    client = create_client(demo=True)
    packs = client.list_packs()
    assert any(p["id"] == "nev-tech" for p in packs)
    roles = client.list_roles()
    assert roles
    skills = client.list_skills()
    assert skills
    kbs = client.list_knowledge()
    assert any(k["id"] == "none" for k in kbs)
    pack = client.get_pack("nev-tech")
    assert pack["id"] == "nev-tech"


def test_cli_pack_list_and_show():
    runner = CliRunner()
    r = runner.invoke(cli, ["pack", "list", "--format", "json"])
    assert r.exit_code == 0
    data = json.loads(r.output)
    assert data["module"] == "pack-list"
    assert data["items"]

    r2 = runner.invoke(cli, ["pack", "show", "nev-tech", "--format", "json"])
    assert r2.exit_code == 0
    shown = json.loads(r2.output)
    assert shown["id"] == "nev-tech"

    r3 = runner.invoke(cli, ["pack", "show", "no-such-pack", "--format", "json"])
    assert r3.exit_code == 1


def test_cli_doctor_and_role_skill_kb():
    runner = CliRunner()
    for args, module in [
        (["role", "list", "--format", "json"], "role-list"),
        (["skill", "list", "--format", "json"], "skill-list"),
        (["knowledge", "list", "--format", "json"], "knowledge-list"),
        (["doctor", "--format", "json"], "doctor"),
    ]:
        r = runner.invoke(cli, args)
        assert r.exit_code == 0, r.output
        data = json.loads(r.output)
        assert data["module"] == module
        if module == "doctor":
            assert data["ok"] is True
        else:
            assert "items" in data


def test_cli_role_show_missing():
    runner = CliRunner()
    r = runner.invoke(cli, ["role", "show", "missing_role_xyz", "--format", "json"])
    assert r.exit_code == 1


def test_cli_run_export(tmp_path, monkeypatch):
    runs = tmp_path / "runs"
    client = create_client(demo=True, runs_dir=str(runs))
    env = client.roundtable("verify-topic", pack="nev-tech", rounds=1)
    monkeypatch.setenv("MULTI_AGENT_RUNS_DIR", str(runs))

    runner = CliRunner()
    env_vars = {**os.environ, "MULTI_AGENT_RUNS_DIR": str(runs)}
    r = runner.invoke(
        cli,
        ["run", "export", env["run_id"], "--what", "delivery", "--format", "markdown"],
        env=env_vars,
    )
    assert r.exit_code == 0, r.output
    assert len(r.output.strip()) > 0

    r2 = runner.invoke(cli, ["run", "list", "--format", "json"], env=env_vars)
    assert r2.exit_code == 0
    data = json.loads(r2.output)
    assert data["module"] == "run-list"
    assert any(i["id"] == env["run_id"] for i in data["items"])
