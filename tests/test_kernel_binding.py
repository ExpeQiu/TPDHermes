"""本机内核识别与绑定：只认扫描结果，不改环境变量。"""

from pathlib import Path

from fastapi.testclient import TestClient

from backend import app
from backend.services.kernel_binding import bind_kernel, list_kernels, read_binding, save_bound_model


def _isolate(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("TPDHERMES_KERNEL_SCAN_ROOTS", str(tmp_path))
    monkeypatch.setenv("TPDHERMES_KERNEL_BINDING_PATH", str(tmp_path / "binding.json"))
    monkeypatch.delenv("HERMES_HOME", raising=False)
    monkeypatch.delenv("DEEPSEEK_HARNESS_HOME", raising=False)
    monkeypatch.delenv("CODEX_HOME", raising=False)
    monkeypatch.setattr("backend.services.kernel_binding.shutil.which", lambda _name: None)
    monkeypatch.setattr("backend.services.kernel_binding._command_version", lambda _cmd: None)


def _platform(payload: dict, kernel_id: str) -> dict:
    return next(row for row in payload["platforms"] if row["id"] == kernel_id)


def test_scan_finds_known_and_extra_harness(monkeypatch, tmp_path: Path):
    _isolate(monkeypatch, tmp_path)
    hermes = tmp_path / "hermes-agent" / "hermes-agent-main" / "hermes_cli"
    hermes.mkdir(parents=True)
    (tmp_path / "hermes-agent" / "hermes-agent-main" / "pyproject.toml").write_text(
        'version = "1.2.3"\n',
        encoding="utf-8",
    )
    deepseek = tmp_path / "opt" / "deepseek-harness"
    deepseek.mkdir(parents=True)
    (deepseek / "pyproject.toml").write_text('version = "0.4.0"\n', encoding="utf-8")
    extra = tmp_path / "vendor" / "acme-harness"
    extra.mkdir(parents=True)
    (extra / "package.json").write_text('{"version":"9.9.9"}\n', encoding="utf-8")
    (tmp_path / "notes").mkdir()

    payload = list_kernels()

    assert payload["bound"] is None
    hermes_installs = _platform(payload, "hermes-agent")["installs"]
    assert len(hermes_installs) == 1
    assert hermes_installs[0]["version"] == "1.2.3"
    assert hermes_installs[0]["evidence"] == ["scan"]
    assert _platform(payload, "deepseek-harness")["installs"][0]["version"] == "0.4.0"
    assert _platform(payload, "codex-harness")["installs"] == []
    assert _platform(payload, "acme-harness")["installs"][0]["root"].endswith("acme-harness")


def test_home_and_command_merge_without_touching_env(monkeypatch, tmp_path: Path):
    _isolate(monkeypatch, tmp_path)
    monkeypatch.setenv("TPDHERMES_KERNEL_SCAN_ROOTS", "")
    home = tmp_path / "hermes-home"
    home.mkdir()
    (home / "config.yaml").write_text("model: {}\n", encoding="utf-8")
    binary = tmp_path / "bin" / "hermes"
    binary.parent.mkdir()
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_CHAT_API_URL", "http://127.0.0.1:8642/v1/chat/completions")

    def which(name: str):
        return str(binary) if name == "hermes" else None

    monkeypatch.setattr("backend.services.kernel_binding.shutil.which", which)
    monkeypatch.setattr("backend.services.kernel_binding._command_version", lambda _cmd: "hermes 2.0.0")

    payload = list_kernels()
    installs = _platform(payload, "hermes-agent")["installs"]

    assert [row["root"] for row in installs] == [str(home.resolve()), str(binary.resolve())]
    assert "HERMES_CHAT_API_URL" in __import__("os").environ
    assert read_binding() is None


def test_bind_persists_only_discovered_root(monkeypatch, tmp_path: Path):
    _isolate(monkeypatch, tmp_path)
    root = tmp_path / "deepseek-harness"
    root.mkdir()
    (root / "pyproject.toml").write_text('version = "0.1.0"\n', encoding="utf-8")

    saved = bind_kernel("deepseek-harness", str(root))
    install = _platform(saved, "deepseek-harness")["installs"][0]

    assert install["bound"] is True
    assert saved["bound"]["present"] is True
    assert read_binding()["kernel_id"] == "deepseek-harness"

    try:
        bind_kernel("codex-harness", str(tmp_path / "missing"))
    except ValueError as exc:
        assert "识别" in str(exc)
    else:
        raise AssertionError("missing kernel should be rejected")


def test_bound_model_reads_and_writes_that_install_only(monkeypatch, tmp_path: Path):
    _isolate(monkeypatch, tmp_path)
    home = tmp_path / "hermes-home"
    deploy = tmp_path / "deploy" / "hermes-agent"
    home.mkdir()
    deploy.mkdir(parents=True)
    (home / "config.yaml").write_text(
        "model:\n  default: MiniMax-M3\n  provider: minimax-cn\n  base_url: https://api.minimaxi.com/anthropic\n",
        encoding="utf-8",
    )
    (deploy / "config.yaml").write_text(
        "model:\n  default: MiniMax-M2.7-highspeed\n  provider: minimax-cn\n  base_url: https://api.minimaxi.com/anthropic\n",
        encoding="utf-8",
    )
    codex = tmp_path / "codex-harness"
    codex.mkdir()
    (codex / "config.toml").write_text('model = "gpt-6.1-sol"\n', encoding="utf-8")
    (codex / "auth.json").write_text("{}\n", encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(home))

    listed = list_kernels()
    by_root = {row["root"]: row for row in _platform(listed, "hermes-agent")["installs"]}
    assert by_root[str(home.resolve())]["model"]["model"] == "MiniMax-M3"
    assert by_root[str(deploy.resolve())]["model"]["model"] == "MiniMax-M2.7-highspeed"
    codex_model = _platform(listed, "codex-harness")["installs"][0]["model"]
    assert codex_model["model"] == "gpt-6.1-sol"
    assert codex_model["key_configured"] is True
    assert "api_key" not in codex_model["fields"]

    bind_kernel("hermes-agent", str(home))
    save_bound_model(provider="minimax-cn", model="MiniMax-Next", base_url="https://api.minimaxi.com/anthropic")
    assert "MiniMax-Next" in (home / "config.yaml").read_text(encoding="utf-8")
    assert "MiniMax-M2.7-highspeed" in (deploy / "config.yaml").read_text(encoding="utf-8")

    bind_kernel("codex-harness", str(codex))
    try:
        save_bound_model(provider="", model="gpt-next", api_key="secret")
    except ValueError as exc:
        assert "密钥" in str(exc)
    else:
        raise AssertionError("codex key write should be rejected")
    assert 'model = "gpt-6.1-sol"' in (codex / "config.toml").read_text(encoding="utf-8")


def test_bound_hermes_gateway_key_overrides_env(monkeypatch, tmp_path: Path):
    _isolate(monkeypatch, tmp_path)
    root = tmp_path / "hermes-home"
    root.mkdir()
    (root / "config.yaml").write_text("model:\n  default: MiniMax-M3\n", encoding="utf-8")
    (root / ".env").write_text('API_SERVER_KEY=gateway-key-from-kernel\nAPI_SERVER_PORT=8642\n', encoding="utf-8")
    monkeypatch.setenv("HERMES_HOME", str(root))
    monkeypatch.setenv("HERMES_CHAT_API_URL", "http://127.0.0.1:8642/v1/chat/completions")
    monkeypatch.setenv("HERMES_CHAT_API_KEY", "test-key")

    from backend.services.kernel_binding import resolve_chat_upstream

    assert resolve_chat_upstream()["api_key"] == "test-key"
    bind_kernel("hermes-agent", str(root))
    upstream = resolve_chat_upstream()
    assert upstream["source"] == "kernel"
    assert upstream["api_key"] == "gateway-key-from-kernel"
    assert upstream["url"] == "http://127.0.0.1:8642/v1/chat/completions"
    assert "gateway-key-from-kernel" not in str(list_kernels())


def test_kernel_routes(monkeypatch, tmp_path: Path):
    _isolate(monkeypatch, tmp_path)
    root = tmp_path / "codex-harness"
    root.mkdir()
    (root / "config.toml").write_text("model = \"gpt\"\n", encoding="utf-8")
    client = TestClient(app)

    listed = client.get("/api/v1/system/kernels")
    assert listed.status_code == 200
    assert _platform(listed.json(), "codex-harness")["installs"]

    bound = client.put(
        "/api/v1/system/kernels/binding",
        json={"kernel_id": "codex-harness", "root": str(root)},
    )
    assert bound.status_code == 200
    assert bound.json()["bound"]["kernel_id"] == "codex-harness"

    config = client.get("/api/v1/system/config")
    assert config.status_code == 200
    assert config.json()["kernel"]["kernel_id"] == "codex-harness"

    cleared = client.delete("/api/v1/system/kernels/binding")
    assert cleared.status_code == 200
    assert cleared.json()["bound"] is None
    assert client.get("/api/v1/system/config").json()["kernel"] is None
