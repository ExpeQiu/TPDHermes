"""Hermes 主模型读写：只改 config.yaml 的 model 段，不回显密钥。"""

from fastapi.testclient import TestClient

from backend import app
from backend.services.hermes_model_config import read_hermes_model, save_hermes_model

_SAMPLE = """\
model:
  default: "MiniMax-M2.7-highspeed"
  provider: "minimax-cn"
  base_url: "https://api.minimaxi.com/anthropic"
  api_key: "sk-should-stay-in-file"

mcp_servers:
  tphermes:
    url: http://tphermes-mcp:8801/mcp

# 生产部署场景：关闭交互式审批。
approvals:
  mode: off
"""


def _isolate_hermes_home(monkeypatch, tmp_path):
    home = tmp_path / "hermes-home"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    return home


def test_read_ignores_chat_model_env_and_hides_key(monkeypatch, tmp_path):
    path = tmp_path / "config.yaml"
    path.write_text(_SAMPLE, encoding="utf-8")
    monkeypatch.setenv("HERMES_AGENT_CONFIG_PATH", str(path))
    monkeypatch.setenv("HERMES_CHAT_MODEL", "hermes-agent")
    monkeypatch.setenv("MINIMAX_CN_API_KEY", "sk-env-secret")
    _isolate_hermes_home(monkeypatch, tmp_path)

    payload = read_hermes_model()
    blob = str(payload)

    assert payload["provider"] == "minimax-cn"
    assert payload["model"] == "MiniMax-M2.7-highspeed"
    assert payload["base_url"] == "https://api.minimaxi.com/anthropic"
    assert payload["key_env"] == "MINIMAX_CN_API_KEY"
    assert payload["key_configured"] is True
    assert "sk-should-stay-in-file" not in blob
    assert "sk-env-secret" not in blob
    assert payload["model"] != "hermes-agent"


def test_key_in_hermes_dotenv_counts_as_configured(monkeypatch, tmp_path):
    path = tmp_path / "config.yaml"
    path.write_text(_SAMPLE, encoding="utf-8")
    home = _isolate_hermes_home(monkeypatch, tmp_path)
    (home / ".env").write_text('MINIMAX_CN_API_KEY="sk-dotenv-secret"\n', encoding="utf-8")
    monkeypatch.setenv("HERMES_AGENT_CONFIG_PATH", str(path))
    monkeypatch.delenv("MINIMAX_CN_API_KEY", raising=False)

    payload = read_hermes_model()

    assert payload["key_configured"] is True
    assert "sk-dotenv-secret" not in str(payload)


def test_blank_key_keeps_existing_secret(monkeypatch, tmp_path):
    path = tmp_path / "config.yaml"
    path.write_text(_SAMPLE, encoding="utf-8")
    home = _isolate_hermes_home(monkeypatch, tmp_path)
    env_file = home / ".env"
    env_file.write_text("MINIMAX_CN_API_KEY=sk-old\nOTHER=keep\n", encoding="utf-8")
    monkeypatch.setenv("HERMES_AGENT_CONFIG_PATH", str(path))
    monkeypatch.delenv("MINIMAX_CN_API_KEY", raising=False)

    saved = save_hermes_model(provider="minimax-cn", model="MiniMax-Next", base_url="https://api.minimaxi.com/anthropic", api_key="  ")

    assert saved["model"] == "MiniMax-Next"
    assert "sk-old" not in str(saved)
    assert env_file.read_text(encoding="utf-8") == "MINIMAX_CN_API_KEY=sk-old\nOTHER=keep\n"


def test_filled_key_replaces_dotenv_without_echo(monkeypatch, tmp_path):
    path = tmp_path / "config.yaml"
    path.write_text(_SAMPLE, encoding="utf-8")
    home = _isolate_hermes_home(monkeypatch, tmp_path)
    env_file = home / ".env"
    env_file.write_text('export MINIMAX_CN_API_KEY="sk-old"\nOTHER=keep\nMINIMAX_CN_API_KEY=sk-dup\n', encoding="utf-8")
    monkeypatch.setenv("HERMES_AGENT_CONFIG_PATH", str(path))
    monkeypatch.delenv("MINIMAX_CN_API_KEY", raising=False)

    saved = save_hermes_model(
        provider="minimax-cn",
        model="MiniMax-M2.7-highspeed",
        base_url="https://api.minimaxi.com/anthropic",
        api_key="sk-new secret",
    )
    text = env_file.read_text(encoding="utf-8")

    assert saved["key_configured"] is True
    assert "sk-new secret" not in str(saved)
    assert "sk-old" not in text
    assert text.count("MINIMAX_CN_API_KEY=") == 1
    assert 'MINIMAX_CN_API_KEY="sk-new secret"' in text
    assert "OTHER=keep" in text


def test_save_replaces_model_block_and_keeps_the_rest(monkeypatch, tmp_path):
    path = tmp_path / "config.yaml"
    path.write_text(_SAMPLE, encoding="utf-8")
    monkeypatch.setenv("HERMES_AGENT_CONFIG_PATH", str(path))
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    _isolate_hermes_home(monkeypatch, tmp_path)

    saved = save_hermes_model(provider="openai", model="gpt-test", base_url="")
    text = path.read_text(encoding="utf-8")

    assert saved["provider"] == "openai"
    assert saved["model"] == "gpt-test"
    assert saved["base_url"] == ""
    assert saved["key_configured"] is False
    assert 'default: gpt-test' in text
    assert "provider: openai" in text
    assert "base_url" not in text.split("mcp_servers:", 1)[0]
    assert "sk-should-stay-in-file" in text
    assert "http://tphermes-mcp:8801/mcp" in text
    assert "# 生产部署场景：关闭交互式审批。" in text
    assert "mode: off" in text


def test_save_rejects_empty_and_bad_url(monkeypatch, tmp_path):
    path = tmp_path / "config.yaml"
    path.write_text(_SAMPLE, encoding="utf-8")
    monkeypatch.setenv("HERMES_AGENT_CONFIG_PATH", str(path))
    _isolate_hermes_home(monkeypatch, tmp_path)

    for kwargs in (
        {"provider": "", "model": "gpt-test"},
        {"provider": "openai", "model": "gpt-test", "base_url": "ftp://example"},
    ):
        try:
            save_hermes_model(**kwargs)
        except ValueError:
            continue
        raise AssertionError(f"expected ValueError for {kwargs}")
    assert "MiniMax-M2.7-highspeed" in path.read_text(encoding="utf-8")


def test_hermes_model_route(monkeypatch, tmp_path):
    path = tmp_path / "config.yaml"
    path.write_text(_SAMPLE, encoding="utf-8")
    monkeypatch.setenv("HERMES_AGENT_CONFIG_PATH", str(path))
    monkeypatch.setenv("MINIMAX_CN_API_KEY", "sk-env-secret")
    _isolate_hermes_home(monkeypatch, tmp_path)

    with TestClient(app) as client:
        got = client.get("/api/v1/system/hermes-model")
        assert got.status_code == 200
        assert "sk-env-secret" not in got.text
        assert "sk-should-stay-in-file" not in got.text
        updated = client.put(
            "/api/v1/system/hermes-model",
            json={"provider": "minimax-cn", "model": "MiniMax-Next", "base_url": "https://api.minimaxi.com/anthropic"},
        )
    assert updated.status_code == 200
    assert updated.json()["model"] == "MiniMax-Next"
    assert "sk-env-secret" not in updated.text
