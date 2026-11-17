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
    "V14": ("SpeechStudio", "SPEECH_STUDIO_URL", "http://127.0.0.1:3217", "/api/health", "speech-rehearsal-studio", "SpeechStudio", ["scripts/start.mjs"], 45),
    "V18": ("FrameFlow", "FRAMEFLOW_URL", "http://127.0.0.1:4318", "/health", "frameflow", "FrameFlow", ["scripts/service.py", "start"], 20),
    "V22": ("Peditor", "PEDITOR_URL", "http://127.0.0.1:4320", "/health", "peditor", "Peditor", ["backend/server.py"], 20),
}
_guard = threading.Lock()
_jobs: dict[str, dict[str, object]] = {}


def _spec(product: str) -> tuple:
    spec = LOCAL_APPS.get(product)
    if spec is None:
        raise HTTPException(404, "未接入的本机应用")
    return spec


def _url(spec: tuple) -> str:
    raw = os.getenv(spec[1], spec[2]).strip() or spec[2]
    if not raw.startswith("http://127.0.0.1:") and not raw.startswith("http://localhost:"):
        raise HTTPException(422, "本机工作台只允许 127.0.0.1 或 localhost")
    return raw.rstrip("/")


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
    directory = Path.home() / "Library/Application Support/TPDHermes/logs"
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
    ready = _probe(url, spec[3], spec[4])
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
    return _payload(product, spec, _url(spec))


def _command(product: str, spec: tuple) -> list[str]:
    root = os.getenv("TPCSTORE_ROOT", "").strip()
    if not root:
        raise HTTPException(503, "未配置 TPCSTORE_ROOT，无法启动本机工作台")
    folder = Path(root).expanduser() / spec[5]
    if product == "V14":
        node = shutil.which(os.getenv("TPCSTORE_NODE_BIN", "node"))
        if not node:
            raise HTTPException(503, "找不到 Node.js，无法启动 SpeechStudio")
        script = folder / spec[6][0]
        if not script.is_file():
            raise HTTPException(503, "SpeechStudio 启动脚本不存在")
        return [node, str(script)]
    if product == "V22":
        python = shutil.which("python3") or sys.executable
        script = folder / spec[6][0]
        if not script.is_file():
            raise HTTPException(503, "Peditor 启动脚本不存在")
        return [python, str(script)]
    script = folder / spec[6][0]
    if not script.is_file():
        raise HTTPException(503, f"{spec[0]} 启动脚本不存在")
    return [sys.executable, str(script), *spec[6][1:]]


def _run(product: str, spec: tuple, url: str, command: list[str]) -> None:
    log_path = _log_path(product)
    cwd = str(Path(command[1]).resolve().parent.parent)
    env = os.environ.copy()
    if product == "V22":
        port = urlparse(url).port
        if port:
            env["PEDITOR_PORT"] = str(port)
    logger.info("studio local app start product=%s command=%s cwd=%s", product, command[1], cwd)
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
        with _guard:
            _jobs[product] = {"phase": "failed", "started": time.time(), "message": f"无法启动：{exc}"}
        logger.warning("studio local app spawn failed product=%s error=%s", product, exc)
        return
    deadline = time.time() + int(spec[7]) + 20
    while time.time() < deadline:
        if _probe(url, spec[3], spec[4]):
            with _guard:
                _jobs[product] = {"phase": "ready", "started": time.time(), "message": ""}
            logger.info("studio local app ready product=%s pid=%s url=%s", product, proc.pid, url)
            return
        if proc.poll() is not None:
            detail = _tail(log_path) or f"启动进程已退出（{proc.returncode}）"
            with _guard:
                _jobs[product] = {"phase": "failed", "started": time.time(), "message": detail}
            logger.warning("studio local app exited product=%s code=%s", product, proc.returncode)
            return
        time.sleep(0.8)
    detail = _tail(log_path) or f"{spec[0]} 启动超时"
    with _guard:
        _jobs[product] = {"phase": "failed", "started": time.time(), "message": detail}
    logger.warning("studio local app timeout product=%s", product)


def start_local_app(product: str) -> dict[str, object]:
    spec = _spec(product)
    url = _url(spec)
    if _probe(url, spec[3], spec[4]):
        with _guard:
            _jobs[product] = {"phase": "ready", "started": time.time(), "message": ""}
        return _payload(product, spec, url)
    command = _command(product, spec)
    with _guard:
        job = _jobs.get(product) or {}
        if job.get("phase") == "starting" and time.time() - float(job.get("started") or 0) < int(spec[7]) + 20:
            return _payload(product, spec, url)
        _jobs[product] = {"phase": "starting", "started": time.time(), "message": f"正在启动 {spec[0]}"}
    threading.Thread(target=_run, args=(product, spec, url, command), name=f"studio-{product}", daemon=True).start()
    logger.info("studio local app queued product=%s url=%s", product, url)
    return _payload(product, spec, url)
