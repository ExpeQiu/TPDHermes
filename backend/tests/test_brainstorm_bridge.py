"""头脑风暴桥接单测（不依赖 live LLM）。"""
from __future__ import annotations

import pytest

from backend.services.brainstorm_bridge import (
    BrainstormBridgeError,
    _normalize_result,
    resolve_mock_mode,
    resolve_multi_agent_root,
    run_roundtable,
)


def test_normalize_result_defaults():
    out = _normalize_result(
        envelope={"run_id": "r1", "mode": "roundtable", "coordinator": "主持人"},
        delivery="# plan",
        trajectory="## t",
        bridge="sdk",
        mock=True,
    )
    assert out["run_id"] == "r1"
    assert out["delivery_markdown"] == "# plan"
    assert out["trajectory_markdown"] == "## t"
    assert out["bridge"] == "sdk"
    assert out["mock"] is True


def test_resolve_mock_mode_default_true_without_key(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("MULTI_AGENT_MOCK_MODE", raising=False)
    # Hermes 不再用 API_KEY 推断 Mock；无显式提示时默认 True
    assert resolve_mock_mode(None) is True
    assert resolve_mock_mode(False) is False
    monkeypatch.setenv("MULTI_AGENT_MOCK_MODE", "false")
    assert resolve_mock_mode(None) is False


@pytest.mark.asyncio
async def test_run_roundtable_sdk_demo(monkeypatch: pytest.MonkeyPatch):
    root = resolve_multi_agent_root()
    if root is None:
        pytest.skip("未找到 TPD-multi-agent")
    monkeypatch.setenv("MULTI_AGENT_MOCK_MODE", "true")
    # 强制跳过 HTTP，走 SDK
    monkeypatch.setenv("MULTI_AGENT_URL", "http://127.0.0.1:1")
    result = await run_roundtable(
        "半固态电池如何对外讲清楚",
        pack="nev-tech",
        rounds=3,
        demo=True,
        prefer_http=False,
        discussion_mode="debate",
        consensus_enabled=True,
        consensus_threshold=0.7,
    )
    assert result["mode"] == "roundtable"
    assert result["bridge"] == "sdk"
    assert result["mock"] is True
    assert result["delivery_markdown"]
    assert result.get("discussion_mode") == "debate"
    assert result.get("consensus_reached") is True
    assert result.get("stopped_at_round") == 2

@pytest.mark.asyncio
async def test_run_roundtable_empty_topic():
    with pytest.raises(BrainstormBridgeError, match="议题"):
        await run_roundtable("  ")
