"""本机智能体内核识别与绑定。

只扫描已知安装位置和有限目录，绑定写入本机配置文件。
不修改环境变量，也不把 .env 盖回已保存的绑定。
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import time
import tomllib
from pathlib import Path
from typing import Any

import yaml

from backend.services.hermes_model_config import _PROVIDER_KEY_ENV, save_hermes_model

logger = logging.getLogger("tpdx.hermes.kernel_binding")

_VERSION_RE = re.compile(r"(?m)^version\s*=\s*[\"']([^\"']+)[\"']")
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$")
_SKIP_DIRS = {
    ".git",
    ".next",
    ".tox",
    ".venv",
    "__pycache__",
    "Cellar",
    "Library",
    "dist",
    "node_modules",
    "site-packages",
    "venv",
}
_MAX_DEPTH = 2

CATALOG: tuple[dict[str, Any], ...] = (
    {
        "id": "hermes-agent",
        "label": "hermes-agent",
        "commands": ("hermes", "hermes-agent"),
        "env_home": "HERMES_HOME",
        "default_homes": ("~/.hermes",),
        "dir_names": ("hermes-agent", "hermes-agent-main"),
    },
    {
        "id": "deepseek-harness",
        "label": "deepseek-harness",
        "commands": ("deepseek-harness",),
        "env_home": "DEEPSEEK_HARNESS_HOME",
        "default_homes": ("~/.deepseek-harness",),
        "dir_names": ("deepseek-harness",),
    },
    {
        "id": "codex-harness",
        "label": "codex-harness",
        "commands": ("codex-harness", "codex"),
        "env_home": "CODEX_HOME",
        "default_homes": ("~/.codex",),
        "dir_names": ("codex-harness",),
    },
)


def binding_path() -> Path:
    override = (os.getenv("TPDHERMES_KERNEL_BINDING_PATH") or "").strip()
    if override:
        return Path(override).expanduser()
    return Path.home() / "Library/Application Support/tphermes/kernel-binding.json"


def _dotenv_get(path: Path, name: str) -> str:
    if not path.is_file():
        return ""
    try:
        lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    except OSError as exc:
        logger.warning("kernel dotenv unreadable path=%s err=%s", path, exc)
        return ""
    prefix = f"{name}="
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :]
        if line.startswith(prefix):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def resolve_chat_upstream() -> dict[str, str]:
    """已绑定的 hermes-agent 网关优先于环境变量里的对话密钥。"""
    env_url = os.getenv("HERMES_CHAT_API_URL", "").strip()
    env_key = os.getenv("HERMES_CHAT_API_KEY", "").strip()
    binding = read_binding()
    if binding and binding.get("kernel_id") == "hermes-agent" and binding.get("root"):
        root = Path(binding["root"])
        dotenv = root / ".env"
        key = _dotenv_get(dotenv, "API_SERVER_KEY")
        if key:
            port = _dotenv_get(dotenv, "API_SERVER_PORT") or "8642"
            host = _dotenv_get(dotenv, "API_SERVER_HOST") or "127.0.0.1"
            if host in {"0.0.0.0", "::"}:
                host = "127.0.0.1"
            if not port.isdigit():
                port = "8642"
            url = f"http://{host}:{port}/v1/chat/completions"
            logger.info(
                "chat upstream source=kernel id=%s host=%s port=%s key_set=true",
                binding["kernel_id"],
                host,
                port,
            )
            return {"url": url, "api_key": key, "source": "kernel"}
        logger.info("chat upstream kernel missing API_SERVER_KEY root=%s", root)
    return {"url": env_url, "api_key": env_key, "source": "env"}


def read_binding() -> dict[str, str] | None:
    path = binding_path()
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("kernel binding unreadable path=%s err=%s", path, exc)
        return None
    if not isinstance(raw, dict):
        return None
    kernel_id = str(raw.get("kernel_id") or "").strip()
    root = str(raw.get("root") or "").strip()
    if not kernel_id:
        return None
    return {"kernel_id": kernel_id, "root": root}


def _isolated_scan() -> bool:
    return os.getenv("TPDHERMES_KERNEL_SCAN_ROOTS") is not None


def scan_roots() -> list[Path]:
    raw = os.getenv("TPDHERMES_KERNEL_SCAN_ROOTS")
    if raw is not None:
        return [Path(part).expanduser() for part in raw.split(os.pathsep) if part.strip()]
    repo = Path(__file__).resolve().parents[2]
    home = Path.home()
    candidates = [
        repo,
        home / "Developer",
        home / "src",
        home / "code",
        home / "Projects",
        home / "dev",
        Path("/opt"),
    ]
    return [path for path in candidates if path.is_dir()]


def _known_ids() -> set[str]:
    return {spec["id"] for spec in CATALOG}


def _spec_by_id(kernel_id: str) -> dict[str, Any] | None:
    for spec in CATALOG:
        if spec["id"] == kernel_id:
            return spec
    return None


def _platform_for_dirname(name: str) -> str | None:
    for spec in CATALOG:
        if name in spec["dir_names"]:
            return spec["id"]
    if name.endswith("-harness") and _ID_RE.fullmatch(name):
        return name
    return None


def _has_marker(path: Path, kernel_id: str) -> bool:
    if kernel_id == "hermes-agent":
        return any(
            (
                (path / "hermes_cli").is_dir(),
                (path / "hermes-agent-main" / "hermes_cli").is_dir(),
                (path / "config.yaml").is_file(),
                (path / "cli.py").is_file(),
            )
        )
    if kernel_id == "codex-harness":
        return any(
            (
                (path / "config.toml").is_file(),
                (path / "auth.json").is_file(),
                (path / "pyproject.toml").is_file(),
                (path / "package.json").is_file(),
            )
        )
    return any(
        (
            (path / "pyproject.toml").is_file(),
            (path / "package.json").is_file(),
            (path / "config.yaml").is_file(),
            (path / "Cargo.toml").is_file(),
            (path / "go.mod").is_file(),
        )
    )


def _read_version(path: Path) -> str | None:
    nested = path / "hermes-agent-main"
    if nested.is_dir():
        nested_version = _read_version(nested)
        if nested_version:
            return nested_version
    pyproject = path / "pyproject.toml"
    if pyproject.is_file():
        try:
            match = _VERSION_RE.search(pyproject.read_text(encoding="utf-8", errors="ignore"))
        except OSError as exc:
            logger.warning("kernel version unreadable path=%s err=%s", pyproject, exc)
            match = None
        if match:
            return match.group(1)[:80]
    package_json = path / "package.json"
    if package_json.is_file():
        try:
            raw = json.loads(package_json.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("kernel version unreadable path=%s err=%s", package_json, exc)
            return None
        if isinstance(raw, dict) and isinstance(raw.get("version"), str):
            return raw["version"][:80]
    return None


def _command_version(command: str) -> str | None:
    try:
        proc = subprocess.run(
            [command, "--version"],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        logger.info("kernel version probe failed command=%s err=%s", command, exc)
        return None
    line = (proc.stdout or proc.stderr or "").strip().splitlines()
    if not line:
        return None
    return line[0].strip()[:120]


def _add_install(
    found: dict[str, list[dict[str, Any]]],
    kernel_id: str,
    root: Path,
    *,
    evidence: str,
    command: str | None = None,
    version: str | None = None,
) -> None:
    try:
        resolved = root.resolve()
    except OSError as exc:
        logger.warning("kernel root unreadable path=%s err=%s", root, exc)
        return
    if not resolved.exists():
        return
    key = str(resolved)
    rows = found.setdefault(kernel_id, [])
    for row in rows:
        if row["root"] == key:
            if evidence not in row["evidence"]:
                row["evidence"].append(evidence)
            if command and not row["command"]:
                row["command"] = command
            if version and not row["version"]:
                row["version"] = version
            return
    rows.append(
        {
            "root": key,
            "command": command,
            "version": version or _read_version(resolved),
            "evidence": [evidence],
        }
    )


def _walk(root: Path, found: dict[str, list[dict[str, Any]]], depth: int = 0) -> None:
    if depth > _MAX_DEPTH or not root.is_dir():
        return
    try:
        entries = list(root.iterdir())
    except OSError as exc:
        logger.warning("kernel scan unreadable path=%s err=%s", root, exc)
        return
    for child in entries:
        try:
            is_dir = child.is_dir()
        except OSError:
            continue
        if not is_dir or child.name in _SKIP_DIRS or child.name.startswith("."):
            continue
        kernel_id = _platform_for_dirname(child.name)
        if kernel_id and _has_marker(child, kernel_id):
            _add_install(found, kernel_id, child, evidence="scan")
            continue
        if depth < _MAX_DEPTH and not child.is_symlink():
            _walk(child, found, depth + 1)


def _home_candidates(spec: dict[str, Any]) -> list[Path]:
    homes: list[Path] = []
    env_name = spec["env_home"]
    raw = os.getenv(env_name, "").strip()
    if raw:
        homes.append(Path(raw).expanduser())
    if not _isolated_scan():
        homes.extend(Path(item).expanduser() for item in spec["default_homes"])
    return homes


def discover_installs() -> dict[str, list[dict[str, Any]]]:
    started = time.perf_counter()
    found: dict[str, list[dict[str, Any]]] = {}
    for spec in CATALOG:
        for home in _home_candidates(spec):
            if home.is_dir() and _has_marker(home, spec["id"]):
                _add_install(found, spec["id"], home, evidence="home")
        for command_name in spec["commands"]:
            command = shutil.which(command_name)
            if not command:
                continue
            binary = Path(command).resolve()
            version = _command_version(str(binary))
            attached = False
            for row in found.get(spec["id"], []):
                try:
                    binary.relative_to(row["root"])
                except ValueError:
                    continue
                if "command" not in row["evidence"]:
                    row["evidence"].append("command")
                row["command"] = str(binary)
                if version and not row["version"]:
                    row["version"] = version
                attached = True
                break
            if not attached:
                _add_install(
                    found,
                    spec["id"],
                    binary,
                    evidence="command",
                    command=str(binary),
                    version=version,
                )
    for root in scan_roots():
        _walk(root, found)
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    count = sum(len(rows) for rows in found.values())
    logger.info("kernel scan found=%s elapsed_ms=%s", count, elapsed_ms)
    return found


_TOML_STRING = re.compile(r'(?m)^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"')


def _config_file(kernel_id: str, root: Path) -> Path | None:
    preferred = ("config.toml", "config.yaml", "config.yml") if kernel_id == "codex-harness" else ("config.yaml", "config.yml", "config.toml")
    for name in preferred:
        candidate = root / name
        if candidate.is_file():
            return candidate
    nested = root / "hermes-agent-main" / "config.yaml"
    if nested.is_file():
        return nested
    return None


def _dotenv_has_at(path: Path, name: str) -> bool:
    if not path.is_file():
        return False
    try:
        lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    except OSError as exc:
        logger.warning("kernel dotenv unreadable path=%s err=%s", path, exc)
        return False
    prefix = f"{name}="
    for raw in lines:
        line = raw.strip()
        if line.startswith("export "):
            line = line[len("export ") :]
        if line.startswith(prefix) and line.split("=", 1)[1].strip().strip("\"'"):
            return True
    return False


def _empty_model(root: Path) -> dict[str, Any]:
    return {
        "config_path": None,
        "config_exists": False,
        "writable": False,
        "provider": "",
        "model": "",
        "base_url": "",
        "key_env": None,
        "key_configured": False,
        "key_writable": False,
        "fields": [],
        "root": str(root),
    }


def _key_state(provider: str, dotenv: Path) -> tuple[str | None, bool, bool]:
    env_name = _PROVIDER_KEY_ENV.get(provider)
    if not env_name:
        return None, False, False
    configured = bool(os.getenv(env_name, "").strip()) or _dotenv_has_at(dotenv, env_name)
    return env_name, configured, True


def _model_from_yaml(path: Path, root: Path) -> dict[str, Any]:
    try:
        loaded = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except (OSError, yaml.YAMLError) as exc:
        logger.warning("kernel model unreadable path=%s err=%s", path, exc)
        loaded = {}
    model = loaded.get("model") if isinstance(loaded, dict) else None
    if isinstance(model, str):
        model = {"default": model}
    if not isinstance(model, dict):
        model = {}
    provider = str(model.get("provider") or "").strip()
    name = ""
    for key in ("default", "model", "name"):
        text = str(model.get(key) or "").strip()
        if text:
            name = text
            break
    key_env, key_configured, key_writable = _key_state(provider, root / ".env")
    return {
        "config_path": str(path),
        "config_exists": True,
        "writable": os.access(path, os.W_OK),
        "provider": provider,
        "model": name,
        "base_url": str(model.get("base_url") or "").strip(),
        "key_env": key_env,
        "key_configured": key_configured,
        "key_writable": key_writable,
        "fields": ["provider", "model", "base_url", "api_key"],
        "root": str(root),
    }


def _toml_strings(path: Path) -> dict[str, str]:
    try:
        text = path.read_text(encoding="utf-8")
        parsed = tomllib.loads(text)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        logger.warning("kernel model unreadable path=%s err=%s", path, exc)
        return {}
    found: dict[str, str] = {}
    if isinstance(parsed, dict):
        for key, value in parsed.items():
            if isinstance(value, str):
                found[key] = value
    return found


def _model_from_toml(path: Path, root: Path) -> dict[str, Any]:
    values = _toml_strings(path)
    fields = ["model"]
    base_url = values.get("base_url") or values.get("openai_base_url") or ""
    if "base_url" in values or "openai_base_url" in values:
        fields.append("base_url")
    return {
        "config_path": str(path),
        "config_exists": True,
        "writable": os.access(path, os.W_OK),
        "provider": "",
        "model": values.get("model", ""),
        "base_url": base_url,
        "key_env": None,
        "key_configured": (root / "auth.json").is_file(),
        "key_writable": False,
        "fields": fields,
        "root": str(root),
    }


def install_model(kernel_id: str, root: Path) -> dict[str, Any]:
    path = _config_file(kernel_id, root)
    if path is None:
        return _empty_model(root)
    if path.suffix == ".toml":
        return _model_from_toml(path, root)
    return _model_from_yaml(path, root)


def _label(kernel_id: str) -> str:
    spec = _spec_by_id(kernel_id)
    return spec["label"] if spec else kernel_id


def list_kernels() -> dict[str, Any]:
    found = discover_installs()
    binding = read_binding()
    bound_key = None
    if binding:
        try:
            bound_key = str(Path(binding["root"]).resolve()) if binding["root"] else ""
        except OSError:
            bound_key = binding["root"]
    present = False
    ordered_ids = [spec["id"] for spec in CATALOG]
    for kernel_id in found:
        if kernel_id not in ordered_ids:
            ordered_ids.append(kernel_id)
    platforms = []
    for kernel_id in ordered_ids:
        installs = []
        for row in found.get(kernel_id, []):
            is_bound = bool(binding and binding["kernel_id"] == kernel_id and row["root"] == bound_key)
            if is_bound:
                present = True
            profile = install_model(kernel_id, Path(row["root"]))
            installs.append({**row, "bound": is_bound, "model": profile})
        platforms.append(
            {
                "id": kernel_id,
                "label": _label(kernel_id),
                "installs": installs,
            }
        )
    bound = None
    if binding:
        bound = {**binding, "present": present, "label": _label(binding["kernel_id"])}
    return {"bound": bound, "platforms": platforms}


def bind_kernel(kernel_id: str, root: str) -> dict[str, Any]:
    kernel_id = kernel_id.strip()
    root = root.strip()
    if not kernel_id or not root:
        raise ValueError("需要指定已识别到的内核和安装位置")
    snapshot = list_kernels()
    match = None
    for platform in snapshot["platforms"]:
        if platform["id"] != kernel_id:
            continue
        for install in platform["installs"]:
            if install["root"] == str(Path(root).expanduser().resolve()):
                match = install
                break
    if match is None:
        raise ValueError("该内核不在本次识别结果中，请先重新识别")
    path = binding_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    document = {"kernel_id": kernel_id, "root": match["root"]}
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(document, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)
    logger.info("kernel bound id=%s root=%s path=%s", kernel_id, match["root"], path)
    return list_kernels()


def _replace_toml_assignment(text: str, key: str, value: str) -> str:
    line = f'{key} = "{value}"'
    pattern = re.compile(rf'(?m)^{re.escape(key)}\s*=.*$')
    if pattern.search(text):
        return pattern.sub(line, text, count=1)
    return line + "\n" + text


def save_bound_model(*, provider: str, model: str, base_url: str = "", api_key: str = "") -> dict[str, Any]:
    binding = read_binding()
    if not binding:
        raise ValueError("尚未绑定内核")
    root = Path(binding["root"])
    profile = install_model(binding["kernel_id"], root)
    if not profile["config_exists"] or not profile["config_path"]:
        raise ValueError("该内核没有模型配置文件")
    if not profile["writable"]:
        raise ValueError("该内核的模型配置不可写")
    config = Path(profile["config_path"])
    if config.suffix == ".toml":
        if re.search(r'[\r\n\x00"]', model) or not model.strip():
            raise ValueError("模型无效")
        if api_key.strip():
            raise ValueError("该内核的密钥不在本页写入")
        if "model" not in profile["fields"]:
            raise ValueError("该内核没有可编辑的模型字段")
        text = config.read_text(encoding="utf-8")
        updated = _replace_toml_assignment(text, "model", model.strip())
        if base_url.strip():
            if "base_url" not in profile["fields"]:
                raise ValueError("该内核的配置里没有 Base URL")
            key = "base_url" if re.search(r'(?m)^base_url\s*=', text) or "openai_base_url" not in text else "openai_base_url"
            updated = _replace_toml_assignment(updated, key, base_url.strip())
        tmp = config.with_suffix(config.suffix + ".tmp")
        tmp.write_text(updated, encoding="utf-8")
        tmp.replace(config)
        logger.info("kernel model saved id=%s path=%s", binding["kernel_id"], config)
        return list_kernels()
    save_hermes_model(
        provider=provider,
        model=model,
        base_url=base_url,
        api_key=api_key,
        config_path=config,
        dotenv_path=root / ".env",
    )
    logger.info("kernel model saved id=%s path=%s", binding["kernel_id"], config)
    return list_kernels()


def unbind_kernel() -> dict[str, Any]:
    path = binding_path()
    if path.is_file():
        path.unlink()
        logger.info("kernel unbound path=%s", path)
    return list_kernels()
