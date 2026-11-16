"""头脑风暴正式圆桌走内核，不触达真实模型。"""
from __future__ import annotations

import pytest

from backend.services.brainstorm_bridge import BrainstormBridgeError, run_roundtable
from backend.services.brainstorm_kernel import run_kernel_roundtable


@pytest.mark.asyncio
async def test_live_roundtable_uses_kernel(monkeypatch: pytest.MonkeyPatch):
    called: dict[str, bool] = {}

    async def fake(*_args, **_kwargs):
        called["ok"] = True
        return {"bridge": "kernel", "delivery_markdown": "计划", "mock": False}

    monkeypatch.setattr(
        "backend.services.brainstorm_kernel.run_kernel_roundtable",
        fake,
    )
    result = await run_roundtable("半固态电池如何对外讲清楚", demo=False, rounds=1)
    assert called["ok"] is True
    assert result["bridge"] == "kernel"


@pytest.mark.asyncio
async def test_kernel_roundtable_stops_on_consensus(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        "backend.services.brainstorm_kernel.kernel_status",
        lambda: {"ready": True, "source": "kernel", "kernel_id": "hermes-agent"},
    )
    monkeypatch.setattr(
        "backend.services.brainstorm_kernel.resolve_multi_agent_root",
        lambda: None,
    )

    async def fake_completion(messages, **_kwargs):
        system = messages[0]["content"]
        user = messages[-1]["content"]
        if "JSON" in user:
            return '{"score": 0.9, "reached": true, "note": "证据已够用，可以收束"}'
        if "Master Plan" in system:
            return "# 圆桌 Master Plan\n\n- 决策：先讲清机理，再给一条可验证动作"
        return "本视角判断：先对齐对外口径，再补一条可核验证据。"

    monkeypatch.setattr(
        "backend.services.brainstorm_kernel.complete_kernel_turn",
        fake_completion,
    )
    seen: list[int] = []

    async def on_progress(progress):
        seen.append(len(progress.get("turns") or []))

    result = await run_kernel_roundtable(
        "半固态电池如何对外讲清楚",
        pack="tech-ip",
        rounds=3,
        discussion_mode="round_robin",
        consensus_enabled=True,
        consensus_threshold=0.7,
        debate_config=None,
        moderator_enabled=True,
        context="资料：热管理系统说明",
        on_progress=on_progress,
    )
    assert result["bridge"] == "kernel"
    assert result["mock"] is False
    assert result["consensus_reached"] is True
    assert result["stopped_at_round"] == 1
    assert "Master Plan" in result["delivery_markdown"]
    assert result["live_turns"]
    assert seen and seen[-1] == len(result["live_turns"])


@pytest.mark.asyncio
async def test_kernel_roundtable_requires_upstream(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        "backend.services.brainstorm_kernel.kernel_status",
        lambda: {"ready": False, "source": "env", "kernel_id": ""},
    )
    with pytest.raises(BrainstormBridgeError, match="内核未就绪"):
        await run_kernel_roundtable(
            "议题",
            pack="tech-ip",
            rounds=1,
            discussion_mode="round_robin",
            consensus_enabled=False,
            consensus_threshold=0.7,
            debate_config=None,
            moderator_enabled=True,
            context=None,
        )
