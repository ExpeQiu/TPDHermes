"""技术卡工作区：Hermes 选动作，目录写卡片。"""

from __future__ import annotations

import asyncio

from fastapi.testclient import TestClient

from backend import app
from backend.services import tech_card_studio as studio


def _turn(message: str, state: dict | None = None) -> dict:
    return asyncio.run(studio.run_studio_turn(message, state if state is not None else studio.create_state()))


def test_mock_extract_lock_and_merge(monkeypatch):
    monkeypatch.setenv("STUDIO_EXECUTION_MODE", "mock")
    monkeypatch.delenv("HERMES_CHAT_API_URL", raising=False)

    extracted = _turn("提取技术卡")
    assert extracted["driver"] == "mock"
    assert len(extracted["state"]["cards"]) == 4
    platform = next(card for card in extracted["state"]["cards"] if card["term"] == "800V 高压平台")
    assert platform["scope"] == ""
    assert "样本未给出持续功率" in studio.SOURCE_TEXT

    selected = dict(extracted["state"])
    selected["selectedCardId"] = platform["id"]
    locked = _turn("锁定当前卡", selected)
    kept = next(card for card in locked["state"]["cards"] if card["id"] == platform["id"])
    assert kept["status"] == "locked"

    again = _turn("再提取一次", locked["state"])
    still = next(card for card in again["state"]["cards"] if card["id"] == platform["id"])
    assert still == kept

    blocked = _turn("合并氛围灯", extracted["state"])
    assert blocked["log"]["ok"] is False
    assert blocked["state"]["cards"] == extracted["state"]["cards"]

    merged = _turn("合并同域", extracted["state"])
    assert merged["log"]["ok"] is True
    assert all(card["term"] != "SiC 逆变器" for card in merged["state"]["cards"])


def test_hermes_tool_call_drives_extract(monkeypatch):
    monkeypatch.setenv("STUDIO_EXECUTION_MODE", "hermes")

    async def fake_fetch(message: str, state: dict):
        assert "提取" in message
        return "extract", ""

    monkeypatch.setattr(studio, "fetch_hermes_operation", fake_fetch)
    result = _turn("请提取技术卡")
    assert result["driver"] == "hermes"
    assert result["fallback_reason"] is None
    assert result["log"]["operation"] == "extract"
    assert len(result["state"]["cards"]) == 4


def test_hermes_failure_uses_same_rules(monkeypatch):
    monkeypatch.setenv("STUDIO_EXECUTION_MODE", "hermes")

    async def fake_fetch(message: str, state: dict):
        raise studio.StudioUpstreamError("upstream_unavailable")

    monkeypatch.setattr(studio, "fetch_hermes_operation", fake_fetch)
    result = _turn("提取技术卡")
    assert result["driver"] == "mock"
    assert result["fallback_reason"] == "upstream_unavailable"
    assert len(result["state"]["cards"]) == 4


def test_studio_route_returns_turn(monkeypatch):
    monkeypatch.setenv("STUDIO_EXECUTION_MODE", "mock")
    with TestClient(app) as client:
        response = client.post(
            "/api/v1/studio/turn",
            json={"message": "查看缺口", "state": studio.create_state(), "demo": True},
        )
    assert response.status_code == 200
    body = response.json()
    assert body["log"]["operation"] == "gaps"
    assert body["state"]["cards"] == []
