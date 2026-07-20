"""圆桌扩展：discussion_mode / debate / consensus。"""

from multi_agent.config import load_settings
from multi_agent.llm import LLMClient
from multi_agent.modes import RoundtableRuntime
from multi_agent.trajectory import TrajectoryStore


def test_roundtable_debate_and_consensus(tmp_path):
    settings = load_settings(demo=True, runs_dir=str(tmp_path / "runs"))
    settings.mock_mode = True
    rt = RoundtableRuntime(settings, TrajectoryStore(settings.runs_dir), LLMClient(settings))
    result = rt.run(
        "半固态如何对外讲清楚",
        pack="tech-ip",
        rounds=3,
        discussion_mode="debate",
        consensus_enabled=True,
        consensus_threshold=0.7,
        debate_config={
            "pro_role_ids": ["ip_strategist", "brand_researcher"],
            "con_role_ids": ["comm_planner"],
            "judge_role_id": "moderator",
        },
    )
    assert result.mode == "roundtable"
    assert result.meta["discussion_mode"] == "debate"
    assert result.meta["consensus_enabled"] is True
    # mock：第 2 轮达成共识并提前终止
    assert result.meta["consensus_reached"] is True
    assert result.meta["stopped_at_round"] == 2
    assert "正方" in result.delivery.body_markdown or "反方" in result.delivery.body_markdown


def test_roundtable_parallel(tmp_path):
    settings = load_settings(demo=True, runs_dir=str(tmp_path / "runs"))
    settings.mock_mode = True
    rt = RoundtableRuntime(settings, TrajectoryStore(settings.runs_dir), LLMClient(settings))
    result = rt.run(
        "并行圆桌冒烟",
        pack="tech-ip",
        rounds=1,
        discussion_mode="parallel",
    )
    assert result.meta["discussion_mode"] == "parallel"
    assert result.delivery.body_markdown


def test_roundtable_injects_attachment_context(tmp_path):
    settings = load_settings(demo=True, runs_dir=str(tmp_path / "runs"))
    settings.mock_mode = True
    rt = RoundtableRuntime(settings, TrajectoryStore(settings.runs_dir), LLMClient(settings))
    result = rt.run(
        "议题带材料",
        pack="tech-ip",
        rounds=1,
        context="### 项目附件材料\n\n半固态电池能量密度 400Wh/kg",
    )
    assert result.meta.get("context_chars", 0) > 0
    assert "400Wh" in result.delivery.body_markdown or "项目附件" in result.delivery.body_markdown
