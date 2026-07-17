"""Settings 持久化：save_settings / 脱敏 / env 覆盖提示。"""

from __future__ import annotations

from pathlib import Path

import yaml

from multi_agent import config as cfg


def test_save_settings_roundtrip(tmp_path, monkeypatch):
    user_cfg = tmp_path / "config.yaml"
    monkeypatch.setattr(cfg, "USER_CONFIG", user_cfg)
    monkeypatch.delenv("MULTI_AGENT_API_KEY", raising=False)
    monkeypatch.delenv("MULTI_AGENT_MOCK_MODE", raising=False)
    monkeypatch.delenv("MULTI_AGENT_KNOWLEDGE_BASE", raising=False)

    saved = cfg.save_settings(
        {
            "mock_mode": True,
            "api_key": "sk-test-secret",
            "api_base": "https://example.com/v1",
            "model": "demo-model",
            "knowledge_base": "tpd-rag-wiki",
        }
    )
    assert saved.mock_mode is True
    assert saved.api_key == "sk-test-secret"
    assert saved.model == "demo-model"
    assert saved.knowledge_base == "tpd-rag-wiki"

    view = cfg.settings_public_view()
    assert view["settings"]["api_key"] == "***"
    assert view["settings"]["has_api_key"] is True
    assert view["settings"]["llm_mode"] == "demo"
    assert Path(view["config_path"]) == user_cfg

    # 空 api_key / *** 不覆盖
    cfg.save_settings({"api_key": "", "model": "kept-key-model"})
    again = cfg.load_settings()
    assert again.api_key == "sk-test-secret"
    assert again.model == "kept-key-model"

    cfg.save_settings({"api_key": "***"})
    assert cfg.load_settings().api_key == "sk-test-secret"

    raw = yaml.safe_load(user_cfg.read_text(encoding="utf-8"))
    assert raw["api_key"] == "sk-test-secret"
    assert "knowledge_base" in raw


def test_env_overrides_reported(tmp_path, monkeypatch):
    user_cfg = tmp_path / "config.yaml"
    monkeypatch.setattr(cfg, "USER_CONFIG", user_cfg)
    monkeypatch.setenv("MULTI_AGENT_MODEL", "from-env")
    assert "model" in cfg.env_overrides()
