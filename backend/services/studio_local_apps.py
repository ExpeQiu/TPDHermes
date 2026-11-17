"""点击技能卡后在后台启动本机工作台，并报告启动进度。"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlparse
from urllib.request import urlopen

from fastapi import HTTPException

logger = logging.getLogger("tpdx.hermes.studio_local")

# name, env, default url, health path, health app id, start args relative to TPCSTORE_ROOT, expected seconds
LOCAL_APPS = {
    "V14": ("SpeechStudio", "SPEECH_STUDIO_URL", "http://127.0.0.1:3217", "/api/health", "speech-rehearsal-studio", "SpeechStudio", ["scripts/start.mjs"], 300),
    "V18": ("FrameFlow", "FRAMEFLOW_URL", "http://127.0.0.1:4318", "/health", "frameflow", "FrameFlow", ["backend/server.mjs"], 180),
    "V22": ("Peditor", "PEDITOR_URL", "http://127.0.0.1:4320", "/health", "peditor", "Peditor", ["backend/server.py"], 40),
}
_guard = threading.Lock()
_jobs: dict[str, dict[str, object]] = {}


def _spec(product: str) -> tuple:
    spec = LOCAL_APPS.get(product)
    if spec is None:
        raise HTTPException(404, "未接入的本机应用")
    return spec


def _loopback_url(spec: tuple) -> str:
    raw = os.getenv(spec[1], spec[2]).strip() or spec[2]
    if not raw.startswith("http://127.0.0.1:") and not raw.startswith("http://localhost:"):
        raise HTTPException(422, "本机工作台只允许 127.0.0.1 或 localhost")
    return raw.rstrip("/")


def _embed_url(spec: tuple) -> str:
    local = _loopback_url(spec)
    host = os.getenv("STUDIO_PUBLIC_HOST", "").strip()
    if not host:
        return local
    port = urlparse(local).port
    return f"http://{host}:{port}"


def _probe(url: str, health: str, app_id: str) -> bool:
    try:
        with urlopen(f"{url}{health}", timeout=2) as response:
            if getattr(response, "status", 0) != 200:
                return False
            payload = json.loads(response.read().decode())
    except (URLError, TimeoutError, OSError, json.JSONDecodeError, ValueError):
        return False
    return isinstance(payload, dict) and payload.get("app") == app_id


def _log_path(product: str) -> Path:
    preferred = Path(os.getenv("STUDIO_LOG_DIR", "/app/data/tpcstore/logs"))
    directory = preferred if preferred.parent.exists() else Path.home() / "Library/Application Support/TPDHermes/logs"
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f"studio-{product.lower()}.log"


def _tail(path: Path) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    line = next((item.strip() for item in reversed(text.splitlines()) if item.strip()), "")
    return line[-240:]


def _payload(product: str, spec: tuple, url: str) -> dict[str, object]:
    name = spec[0]
    ready = _probe(_loopback_url(spec), spec[3], spec[4])
    job = _jobs.get(product) or {}
    phase = str(job.get("phase") or "idle")
    if ready:
        phase = "ready"
        progress = 100
        message = ""
    elif phase == "starting":
        elapsed = time.time() - float(job.get("started") or time.time())
        progress = min(90, max(8, int(elapsed / max(int(spec[7]), 1) * 90)))
        message = f"正在启动 {name}"
    elif phase == "failed":
        progress = 100
        message = str(job.get("message") or f"{name} 启动失败")
    else:
        phase = "idle"
        progress = 0
        message = ""
    return {
        "product": product,
        "name": name,
        "url": url,
        "ready": ready,
        "phase": phase,
        "progress": progress,
        "message": message,
    }


def local_app_status(product: str) -> dict[str, object]:
    spec = _spec(product)
    return _payload(product, spec, _embed_url(spec))


def _node_bin() -> str:
    configured = os.getenv("TPCSTORE_NODE_BIN", "node")
    node = shutil.which(configured) or (configured if Path(configured).is_file() else "")
    if not node:
        raise HTTPException(503, "找不到 Node.js，无法启动工作台")
    return node


def _app_dir(spec: tuple) -> Path:
    root = os.getenv("TPCSTORE_ROOT", "").strip()
    if not root:
        raise HTTPException(503, "未配置 TPCSTORE_ROOT，无法启动本机工作台")
    source = Path(root).expanduser() / spec[5]
    script = source / spec[6][0]
    if not script.is_file():
        if spec[5] == "SpeechStudio":
            raise HTTPException(503, "SpeechStudio 启动脚本不存在")
        if spec[5] == "Peditor":
            raise HTTPException(503, "Peditor 启动脚本不存在")
        raise HTTPException(503, f"{spec[0]} 启动脚本不存在")
    if os.access(source, os.W_OK):
        return source
    dest = Path(os.getenv("STUDIO_APP_ROOT", "/app/data/tpcstore/apps")) / spec[5]
    marker = dest / ".hermes-runtime"
    if marker.is_file():
        return dest
    logger.info("studio local app copy name=%s dest=%s", spec[0], dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(source, dest, ignore=shutil.ignore_patterns("node_modules", ".git", ".next", "dist"))
    marker.write_text("copied\n", encoding="utf-8")
    return dest


def _npm(directory: Path, args: list[str], log_path: Path) -> None:
    npm = shutil.which("npm")
    if not npm:
        raise HTTPException(503, "找不到 npm")
    env = os.environ.copy()
    env["npm_config_registry"] = "https://registry.npmmirror.com"
    logger.info("studio npm args=%s cwd=%s", args, directory)
    with log_path.open("ab") as handle:
        handle.write(f"\n--- npm {' '.join(args)} ---\n".encode())
        completed = subprocess.run(
            [npm, *args],
            cwd=directory,
            env=env,
            stdout=handle,
            stderr=subprocess.STDOUT,
            check=False,
        )
    if completed.returncode != 0:
        raise HTTPException(503, _tail(log_path) or "依赖安装失败")


def _ensure_runtime(product: str, directory: Path, log_path: Path) -> None:
    if product == "V14" and not (directory / "node_modules" / "next").exists():
        _npm(directory, ["ci", "--omit=dev"], log_path)
    if product == "V14" and not (directory / "node_modules" / "typescript").exists():
        _npm(directory, ["install", "--no-save", "typescript@5.9.3"], log_path)
    if product == "V14" and not (directory / ".next" / "BUILD_ID").is_file():
        _npm(directory, ["run", "build"], log_path)
    if product == "V18" and sys.platform != "darwin":
        if not (directory / "node_modules" / "vite").exists():
            _npm(directory, ["ci"], log_path)
        if not (directory / "dist" / "index.html").is_file():
            _npm(directory, ["run", "build"], log_path)


def _command(product: str, spec: tuple) -> list[str]:
    folder = _app_dir(spec)
    if product == "V14":
        command = [_node_bin(), str(folder / spec[6][0])]
        if (folder / ".next" / "BUILD_ID").is_file():
            command.append("--production")
        return command
    if product == "V22":
        python = shutil.which("python3") or sys.executable
        return [python, str(folder / spec[6][0])]
    if product == "V18" and sys.platform != "darwin":
        return [_node_bin(), str(folder / "backend" / "server.mjs")]
    if product == "V18":
        script = folder / "scripts" / "service.py"
        if not script.is_file():
            raise HTTPException(503, "FrameFlow 启动脚本不存在")
        return [sys.executable, str(script), "start"]
    return [sys.executable, str(folder / spec[6][0]), *spec[6][1:]]


def _child_env(product: str, local_url: str) -> dict[str, str]:
    env = os.environ.copy()
    port = urlparse(local_url).port
    if os.getenv("STUDIO_PUBLIC_HOST"):
        env["BIND_HOST"] = "0.0.0.0"
        env["STUDIO_PUBLIC_HOST"] = os.environ["STUDIO_PUBLIC_HOST"]
    if port:
        env["PORT"] = str(port)
    if product == "V22" and port:
        env["PEDITOR_PORT"] = str(port)
        env["PEDITOR_DATA_DIR"] = os.getenv("PEDITOR_DATA_DIR", "/app/data/tpcstore/peditor")
    if product == "V18":
        env["FRAMEFLOW_DATA"] = os.getenv("FRAMEFLOW_DATA", "/app/data/tpcstore/frameflow")
    return env


def _fail(product: str, message: str) -> None:
    with _guard:
        _jobs[product] = {"phase": "failed", "started": time.time(), "message": message}
    logger.warning("studio local app failed product=%s message=%s", product, message)


def _run(product: str, spec: tuple, local_url: str, command: list[str]) -> None:
    log_path = _log_path(product)
    cwd = str(Path(command[1]).resolve().parent.parent)
    try:
        _ensure_runtime(product, Path(cwd), log_path)
        command = _command(product, spec)
    except HTTPException as exc:
        _fail(product, str(exc.detail))
        return
    except OSError as exc:
        _fail(product, f"准备运行目录失败：{exc}")
        return
    env = _child_env(product, local_url)
    logger.info("studio local app start product=%s command=%s cwd=%s", product, command, cwd)
    try:
        with log_path.open("ab") as handle:
            handle.write(f"\n--- start {product} ---\n".encode())
            proc = subprocess.Popen(
                command,
                cwd=cwd,
                env=env,
                stdout=handle,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
    except OSError as exc:
        _fail(product, f"无法启动：{exc}")
        return
    deadline = time.time() + int(spec[7]) + 20
    while time.time() < deadline:
        if _probe(local_url, spec[3], spec[4]):
            with _guard:
                _jobs[product] = {"phase": "ready", "started": time.time(), "message": ""}
            logger.info("studio local app ready product=%s pid=%s url=%s", product, proc.pid, local_url)
            return
        if proc.poll() is not None:
            _fail(product, _tail(log_path) or f"启动进程已退出（{proc.returncode}）")
            return
        time.sleep(0.8)
    _fail(product, _tail(log_path) or f"{spec[0]} 启动超时")


def start_local_app(product: str) -> dict[str, object]:
    spec = _spec(product)
    local_url = _loopback_url(spec)
    embed = _embed_url(spec)
    if _probe(local_url, spec[3], spec[4]):
        with _guard:
            _jobs[product] = {"phase": "ready", "started": time.time(), "message": ""}
        return _payload(product, spec, embed)
    command = _command(product, spec)
    with _guard:
        job = _jobs.get(product) or {}
        if job.get("phase") == "starting" and time.time() - float(job.get("started") or 0) < int(spec[7]) + 20:
            return _payload(product, spec, embed)
        _jobs[product] = {"phase": "starting", "started": time.time(), "message": f"正在启动 {spec[0]}"}
    threading.Thread(target=_run, args=(product, spec, local_url, command), name=f"studio-{product}", daemon=True).start()
    logger.info("studio local app queued product=%s url=%s", product, embed)
    return _payload(product, spec, embed)
