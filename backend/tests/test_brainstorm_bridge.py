"""头脑风暴桥接单测（不依赖 live LLM）。"""
from __future__ import annotations

import pytest

from backend.services.brainstorm_bridge import (
    BrainstormBridgeError,
    _normalize_result,
    _sdk_fallback_allowed,
    resolve_mock_mode,
    resolve_multi_agent_root,
    resolve_progress_timeout,
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


def test_resolve_progress_timeout_scales_with_rounds(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("MULTI_AGENT_PROGRESS_TIMEOUT_BASE", "300")
    monkeypatch.setenv("MULTI_AGENT_PROGRESS_TIMEOUT_PER_ROUND", "90")
    # 重新读取模块级常量需直接测函数逻辑：函数内部读的是导入时常量
    # 因此用当前已加载默认值做行为断言
    from backend.services import brainstorm_bridge as bb

    monkeypatch.setattr(bb, "PROGRESS_TIMEOUT_BASE", 300.0)
    monkeypatch.setattr(bb, "PROGRESS_TIMEOUT_PER_ROUND", 90.0)
    assert bb.resolve_progress_timeout(2, demo=False) == 300.0
    assert bb.resolve_progress_timeout(5, demo=False) == 450.0
    assert bb.resolve_progress_timeout(5, demo=True) <= 125.0


def test_sdk_fallback_disabled_without_root(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("MULTI_AGENT_SDK_FALLBACK", raising=False)
    monkeypatch.setattr(
        "backend.services.brainstorm_bridge.resolve_multi_agent_root",
        lambda: None,
    )
    assert _sdk_fallback_allowed(prefer_http=None) is False
    assert _sdk_fallback_allowed(prefer_http=True) is False
    # 显式 prefer_http=False 仍允许 SDK（本地单测路径）
    assert _sdk_fallback_allowed(prefer_http=False) is True
    monkeypatch.setenv("MULTI_AGENT_SDK_FALLBACK", "false")
    assert _sdk_fallback_allowed(prefer_http=False) is True
    assert _sdk_fallback_allowed(prefer_http=None) is False


@pytest.mark.asyncio
async def test_http_failure_preserves_timeout_message(monkeypatch: pytest.MonkeyPatch):
    """生产无 SDK 时，应保留 HTTP 超时原文，而非「未找到 TPD-multi-agent」。"""
    monkeypatch.setenv("MULTI_AGENT_SDK_FALLBACK", "false")
    monkeypatch.setattr(
        "backend.services.brainstorm_bridge.resolve_multi_agent_root",
        lambda: None,
    )

    async def boom(*_a, **_k):
        raise BrainstormBridgeError("轮询 progress 超时 run_id=r-test")

    monkeypatch.setattr(
        "backend.services.brainstorm_bridge._run_via_http",
        boom,
    )
    with pytest.raises(BrainstormBridgeError, match="轮询 progress 超时"):
        await run_roundtable("议题", prefer_http=True, demo=True)


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
        pack="tech-ip",
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
