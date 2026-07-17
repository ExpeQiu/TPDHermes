import json

from multi_agent.config import load_settings
from multi_agent.sdk import create_client
from multi_agent.selector import select_mode


def test_select_mode_debate():
    d = select_mode("怎么推技术信仰")
    assert d.mode == "roundtable"


def test_select_mode_swarm():
    d = select_mode("对比三家供应链调研")
    assert d.mode == "swarm"


def test_sdk_demo_roundtrip(tmp_path):
    client = create_client(demo=True, runs_dir=str(tmp_path / "runs"))
    env = client.swarm("对比供应链", max_parallel=2, pack="nev-tech")
    assert env["data_source"] == "none"
    assert env["delivery"]["body_markdown"]
    assert client.status(env["run_id"])
    assert "分派" in client.trajectory(env["run_id"]) or "完成" in client.trajectory(env["run_id"])


def test_consult_and_auto(tmp_path):
    client = create_client(demo=True, runs_dir=str(tmp_path / "runs"))
    c = client.consult("包装成抖音脚本", pack="nev-tech", expert="tech")
    assert c["mode"] == "consult"
    a = client.run("怎么推高端信仰", mode="auto", pack="nev-tech", rounds=1)
    assert a["mode"] == "roundtable"
    assert a["module"] == "run-start"


def test_load_settings_demo_override(monkeypatch):
    monkeypatch.delenv("MULTI_AGENT_MOCK_MODE", raising=False)
    monkeypatch.delenv("MULTI_AGENT_KNOWLEDGE_BASE", raising=False)
    s = load_settings(demo=True)
    assert s.mock_mode is True
    assert s.llm_mode == "demo"
    assert s.data_source == "none"


def test_knowledge_catalog_and_local_retrieve():
    from multi_agent.knowledge import list_knowledge_bases, retrieve_context

    items = list_knowledge_bases()
    ids = {i["id"] for i in items}
    assert "none" in ids
    assert "tpd-rag-wiki" in ids
    # 本地 wiki 路径可用时，应能打出命中片段
    block = retrieve_context("tpd-rag-wiki", "技术推广方法论")
    assert "知识库检索" in block or block == ""
