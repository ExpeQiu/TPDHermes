"""简易 Web：静态前端 + API（启动协作 / 浏览 runs / 配置 Skill Pack）。"""

from __future__ import annotations

import json
import logging
import os
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

WEB_ROOT = Path(__file__).resolve().parent
STATIC_ROOT = WEB_ROOT / "static"
REPO_ROOT = WEB_ROOT.parent.parent
logger = logging.getLogger("multi_agent.web")

# run_id -> {done: bool, error: str|None, thread: Thread}
_ASYNC_RUNS: dict[str, dict] = {}
_ASYNC_LOCK = threading.Lock()


def _ensure_repo_path() -> None:
    if str(REPO_ROOT) not in sys.path:
        sys.path.insert(0, str(REPO_ROOT))


def runs_root() -> Path:
    return Path(os.environ.get("MULTI_AGENT_RUNS_DIR", "runs")).resolve()


def _store():
    _ensure_repo_path()
    from multi_agent.trajectory import TrajectoryStore

    return TrajectoryStore(runs_root())


def list_runs() -> list[dict]:
    return _store().list_runs()


def load_run(run_id: str) -> dict | None:
    return _store().load_bundle(run_id)


def load_progress(run_id: str) -> dict | None:
    store = _store()
    progress = store.load_progress(run_id)
    if progress is None:
        state = store.load_state(run_id)
        if state is None:
            return None
        return {
            "run_id": run_id,
            "status": state.get("status") or "unknown",
            "turns": [],
            "title": "",
            "topic": state.get("topic") or "",
            "error": state.get("error"),
            "updated_at": state.get("updated_at"),
        }
    return progress


def _build_run_kwargs(payload: dict) -> dict:
    """从请求 payload 解析 execute_run 参数（不含 goal/mode）。"""
    pack = payload.get("pack") or "tech-ip"
    knowledge_base = (
        payload.get("knowledge_base")
        or payload.get("kb")
        or payload.get("data_source")
        or "none"
    )
    demo = payload.get("demo")
    if isinstance(demo, str):
        demo = demo.lower() in {"1", "true", "yes", "on"}

    rounds_raw = payload.get("rounds", 2)
    try:
        rounds = max(1, min(int(rounds_raw), 8))
    except (TypeError, ValueError):
        rounds = 2

    discussion_mode = (
        payload.get("discussion_mode")
        or payload.get("discussionMode")
        or "round_robin"
    )
    consensus_enabled = bool(
        payload.get("consensus_enabled")
        if payload.get("consensus_enabled") is not None
        else payload.get("consensusEnabled", False)
    )
    try:
        consensus_threshold = float(
            payload.get("consensus_threshold")
            if payload.get("consensus_threshold") is not None
            else payload.get("consensusThreshold", 0.7)
        )
    except (TypeError, ValueError):
        consensus_threshold = 0.7
    debate_config = payload.get("debate_config") or payload.get("debateConfig")
    if debate_config is not None and not isinstance(debate_config, dict):
        debate_config = None
    moderator_enabled = payload.get("moderator_enabled")
    if moderator_enabled is None:
        moderator_enabled = payload.get("moderatorEnabled", True)
    moderator_enabled = bool(moderator_enabled)

    context = (
        payload.get("context")
        or payload.get("context_markdown")
        or payload.get("contextMarkdown")
        or ""
    )
    if not isinstance(context, str):
        context = str(context or "")

    return {
        "pack": pack,
        "knowledge_base": str(knowledge_base),
        "demo": demo,
        "rounds": rounds,
        "discussion_mode": discussion_mode,
        "consensus_enabled": consensus_enabled,
        "consensus_threshold": consensus_threshold,
        "debate_config": debate_config,
        "moderator_enabled": moderator_enabled,
        "context": context.strip(),
    }


def execute_run(payload: dict, *, on_started=None) -> dict:
    """调用本地 Runtime（默认 demo LLM；数据源为知识库绑定）。"""
    _ensure_repo_path()

    from multi_agent.config import load_settings
    from multi_agent.coordinator import CoordinatorFacade

    goal = (payload.get("goal") or "").strip()
    if not goal:
        raise ValueError("goal 不能为空")
    mode = (payload.get("mode") or "auto").strip().lower()
    opts = _build_run_kwargs(payload)

    settings = load_settings(
        demo=opts["demo"],
        pack=opts["pack"],
        knowledge_base=opts["knowledge_base"],
        runs_dir=str(runs_root()),
    )
    if opts["demo"] is not None:
        settings.mock_mode = bool(opts["demo"])
    # Web 默认无 Key 时仍用 mock，避免误连 live
    if not settings.api_key and not settings.mock_mode:
        settings.mock_mode = True
        logger.info("无 API Key，Web 运行强制 llm=demo")

    logger.info(
        "execute_run | mode=%s pack=%s rounds=%s discussion_mode=%s consensus=%s demo=%s context_chars=%s",
        mode,
        opts["pack"],
        opts["rounds"],
        opts["discussion_mode"],
        opts["consensus_enabled"],
        settings.mock_mode,
        len(opts["context"]),
    )

    facade = CoordinatorFacade(settings)
    result = facade.run(
        goal,
        mode=mode,
        pack=opts["pack"],
        topic=goal if mode == "roundtable" else None,
        rounds=opts["rounds"],
        max_parallel=settings.max_parallel,
        discussion_mode=str(opts["discussion_mode"]),
        consensus_enabled=opts["consensus_enabled"],
        consensus_threshold=opts["consensus_threshold"],
        debate_config=opts["debate_config"],
        moderator_enabled=opts["moderator_enabled"],
        context=opts["context"] or None,
        on_started=on_started,
    )
    loaded = load_run(result.run_id) or {}
    return {
        "envelope": result.to_envelope(),
        "delivery": loaded.get("delivery") or result.delivery.body_markdown,
        "trajectory": loaded.get("trajectory") or "",
    }


def start_execute_run_async(payload: dict) -> dict:
    """后台启动圆桌，尽快返回 run_id，供前端/桥接轮询 progress。"""
    ready = threading.Event()
    box: dict = {"run_id": None, "error": None}

    def on_started(run_id: str) -> None:
        box["run_id"] = run_id
        with _ASYNC_LOCK:
            _ASYNC_RUNS[run_id] = {"done": False, "error": None}
        ready.set()
        logger.info("async run started run_id=%s", run_id)

    def worker() -> None:
        run_id = None
        try:
            result = execute_run(payload, on_started=on_started)
            env = result.get("envelope") or {}
            run_id = str(env.get("run_id") or box.get("run_id") or "")
            with _ASYNC_LOCK:
                if run_id:
                    _ASYNC_RUNS[run_id] = {"done": True, "error": None, "result": result}
            logger.info("async run completed run_id=%s", run_id)
        except Exception as exc:  # noqa: BLE001
            err = str(exc)
            box["error"] = err
            if not ready.is_set():
                ready.set()
            run_id = box.get("run_id")
            if run_id:
                try:
                    _store().mark_progress_status(run_id, "failed", error=err)
                except Exception:  # noqa: BLE001
                    pass
                with _ASYNC_LOCK:
                    _ASYNC_RUNS[run_id] = {"done": True, "error": err}
            logger.exception("async run failed: %s", exc)

    thread = threading.Thread(target=worker, name="ma-run-async", daemon=True)
    thread.start()
    if not ready.wait(timeout=60):
        raise TimeoutError("圆桌 run_id 未在 60s 内创建")
    if box.get("error") and not box.get("run_id"):
        raise RuntimeError(box["error"])
    run_id = box.get("run_id")
    if not run_id:
        raise RuntimeError("未能创建 run_id")
    return {"run_id": run_id, "status": "running", "async": True}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(
        self,
        code: int,
        body: bytes,
        content_type: str = "text/html; charset=utf-8",
    ) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, code: int, obj: dict) -> None:
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self._send(code, data, "application/json; charset=utf-8")

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        if not raw:
            return {}
        data = json.loads(raw.decode("utf-8"))
        return data if isinstance(data, dict) else {}

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        if path in ("/", "/index.html"):
            index = STATIC_ROOT / "index.html"
            self._send(200, index.read_bytes(), "text/html; charset=utf-8")
            return

        if path in ("/packs", "/packs.html"):
            page = STATIC_ROOT / "packs.html"
            self._send(200, page.read_bytes(), "text/html; charset=utf-8")
            return

        if path in ("/roles", "/roles.html"):
            page = STATIC_ROOT / "roles.html"
            self._send(200, page.read_bytes(), "text/html; charset=utf-8")
            return

        if path in ("/skills", "/skills.html"):
            page = STATIC_ROOT / "skills.html"
            self._send(200, page.read_bytes(), "text/html; charset=utf-8")
            return

        if path in ("/settings", "/settings.html"):
            page = STATIC_ROOT / "settings.html"
            self._send(200, page.read_bytes(), "text/html; charset=utf-8")
            return

        if path.startswith("/static/"):
            rel = path[len("/static/") :]
            target = (STATIC_ROOT / rel).resolve()
            if not str(target).startswith(str(STATIC_ROOT.resolve())) or not target.is_file():
                self._send(404, b"not found", "text/plain; charset=utf-8")
                return
            ctype = "text/plain; charset=utf-8"
            if target.suffix == ".css":
                ctype = "text/css; charset=utf-8"
            elif target.suffix == ".js":
                ctype = "application/javascript; charset=utf-8"
            elif target.suffix == ".html":
                ctype = "text/html; charset=utf-8"
            self._send(200, target.read_bytes(), ctype)
            return

        if path == "/api/runs":
            self._send_json(200, {"items": list_runs()})
            return

        if path.startswith("/api/runs/"):
            rest = path[len("/api/runs/") :].strip("/")
            if rest.endswith("/progress"):
                run_id = rest[: -len("/progress")].strip("/")
                data = load_progress(run_id)
                if data is None:
                    self._send_json(404, {"error": f"找不到 run progress: {run_id}"})
                    return
                self._send_json(200, data)
                return
            run_id = rest
            data = load_run(run_id)
            if data is None:
                self._send_json(404, {"error": f"找不到 run: {run_id}"})
                return
            self._send_json(200, data)
            return

        if path == "/api/packs":
            try:
                _ensure_repo_path()
                from multi_agent.skill_packs import list_packs_meta

                self._send_json(200, {"items": list_packs_meta()})
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write(traceback.format_exc())
                self._send_json(500, {"error": str(exc)})
            return

        if path.startswith("/api/packs/"):
            pack_id = path[len("/api/packs/") :].strip("/")
            try:
                _ensure_repo_path()
                from multi_agent.skill_packs import load_pack
                from multi_agent.utils.errors import MultiAgentError

                data = load_pack(pack_id)
                clean = {k: v for k, v in data.items() if not str(k).startswith("_")}
                self._send_json(200, clean)
            except MultiAgentError as exc:
                self._send_json(404, {"error": str(exc)})
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write(traceback.format_exc())
                self._send_json(500, {"error": str(exc)})
            return

        if path == "/api/roles":
            try:
                _ensure_repo_path()
                from multi_agent.roles import list_roles_meta

                self._send_json(200, {"items": list_roles_meta()})
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write(traceback.format_exc())
                self._send_json(500, {"error": str(exc)})
            return

        if path.startswith("/api/roles/"):
            role_id = path[len("/api/roles/") :].strip("/")
            try:
                _ensure_repo_path()
                from multi_agent.roles import load_role
                from multi_agent.utils.errors import MultiAgentError

                self._send_json(200, load_role(role_id))
            except MultiAgentError as exc:
                self._send_json(404, {"error": str(exc)})
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write(traceback.format_exc())
                self._send_json(500, {"error": str(exc)})
            return

        if path == "/api/skills":
            try:
                _ensure_repo_path()
                from multi_agent.skills import list_skills_meta

                self._send_json(200, {"items": list_skills_meta()})
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write(traceback.format_exc())
                self._send_json(500, {"error": str(exc)})
            return

        if path.startswith("/api/skills/"):
            skill_id = path[len("/api/skills/") :].strip("/")
            try:
                _ensure_repo_path()
                from multi_agent.skills import load_skill
                from multi_agent.utils.errors import MultiAgentError

                self._send_json(200, load_skill(skill_id))
            except MultiAgentError as exc:
                self._send_json(404, {"error": str(exc)})
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write(traceback.format_exc())
                self._send_json(500, {"error": str(exc)})
            return

        if path == "/api/health":
            try:
                _ensure_repo_path()
                from multi_agent.config import load_settings

                settings = load_settings()
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "service": "multi-agent-web",
                        "mock": bool(settings.mock_mode),
                        "llm_mode": settings.llm_mode,
                        "ai_owner": "multi-agent",
                    },
                )
            except Exception:
                self._send_json(200, {"ok": True, "service": "multi-agent-web"})
            return

        if path == "/api/knowledge-bases":
            try:
                _ensure_repo_path()
                from multi_agent.knowledge import list_knowledge_bases

                self._send_json(200, {"items": list_knowledge_bases()})
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write(traceback.format_exc())
                self._send_json(500, {"error": str(exc)})
            return

        if path == "/api/settings":
            try:
                _ensure_repo_path()
                from multi_agent.config import settings_public_view

                self._send_json(200, settings_public_view())
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write(traceback.format_exc())
                self._send_json(500, {"error": str(exc)})
            return

        self._send(404, b"not found", "text/plain; charset=utf-8")

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path == "/api/run":
            try:
                payload = self._read_json()
                result = execute_run(payload)
                self._send_json(200, result)
            except ValueError as exc:
                self._send_json(400, {"error": str(exc)})
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write(traceback.format_exc())
                self._send_json(500, {"error": str(exc)})
            return

        if path in ("/api/run/async", "/api/run-async"):
            try:
                payload = self._read_json()
                started = start_execute_run_async(payload)
                self._send_json(202, started)
            except ValueError as exc:
                self._send_json(400, {"error": str(exc)})
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write(traceback.format_exc())
                self._send_json(500, {"error": str(exc)})
            return

        if path == "/api/packs":
            try:
                _ensure_repo_path()
                from multi_agent.skill_packs import save_pack
                from multi_agent.utils.errors import MultiAgentError

                payload = self._read_json()
                logger.info("创建 skill pack payload_id=%s", payload.get("id"))
                saved = save_pack(payload, create=True)
                self._send_json(201, saved)
            except MultiAgentError as exc:
                self._send_json(400, {"error": str(exc)})
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write(traceback.format_exc())
                self._send_json(500, {"error": str(exc)})
            return

        if path == "/api/roles":
            try:
                _ensure_repo_path()
                from multi_agent.roles import save_role
                from multi_agent.utils.errors import MultiAgentError

                payload = self._read_json()
                logger.info("创建 role payload_id=%s", payload.get("id"))
                saved = save_role(payload, create=True)
                self._send_json(201, saved)
            except MultiAgentError as exc:
                self._send_json(400, {"error": str(exc)})
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write(traceback.format_exc())
                self._send_json(500, {"error": str(exc)})
            return

        if path == "/api/skills/import":
            try:
                _ensure_repo_path()
                from multi_agent.skills import import_skill_markdown
                from multi_agent.utils.errors import MultiAgentError

                payload = self._read_json()
                logger.info("导入 skill source=%s", payload.get("source"))
                saved = import_skill_markdown(
                    str(payload.get("markdown") or ""),
                    source=str(payload.get("source") or "paste"),
                )
                self._send_json(201, saved)
            except MultiAgentError as exc:
                self._send_json(400, {"error": str(exc)})
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write(traceback.format_exc())
                self._send_json(500, {"error": str(exc)})
            return

        if path == "/api/skills":
            try:
                _ensure_repo_path()
                from multi_agent.skills import save_skill
                from multi_agent.utils.errors import MultiAgentError

                payload = self._read_json()
                logger.info("创建 skill payload_id=%s", payload.get("id"))
                saved = save_skill(payload, create=True)
                self._send_json(201, saved)
            except MultiAgentError as exc:
                self._send_json(400, {"error": str(exc)})
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write(traceback.format_exc())
                self._send_json(500, {"error": str(exc)})
            return

        self._send_json(404, {"error": "not found"})

    def do_PUT(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path.startswith("/api/packs/"):
            pack_id = path[len("/api/packs/") :].strip("/")
            try:
                _ensure_repo_path()
                from multi_agent.skill_packs import save_pack
                from multi_agent.utils.errors import MultiAgentError

                payload = self._read_json()
                payload["id"] = pack_id
                logger.info("更新 skill pack id=%s", pack_id)
                saved = save_pack(payload, create=False)
                self._send_json(200, saved)
            except MultiAgentError as exc:
                self._send_json(400, {"error": str(exc)})
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write(traceback.format_exc())
                self._send_json(500, {"error": str(exc)})
            return

        if path.startswith("/api/roles/"):
            role_id = path[len("/api/roles/") :].strip("/")
            try:
                _ensure_repo_path()
                from multi_agent.roles import save_role
                from multi_agent.utils.errors import MultiAgentError

                payload = self._read_json()
                payload["id"] = role_id
                logger.info("更新 role id=%s", role_id)
                saved = save_role(payload, create=False)
                self._send_json(200, saved)
            except MultiAgentError as exc:
                self._send_json(400, {"error": str(exc)})
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write(traceback.format_exc())
                self._send_json(500, {"error": str(exc)})
            return

        if path.startswith("/api/skills/"):
            skill_id = path[len("/api/skills/") :].strip("/")
            try:
                _ensure_repo_path()
                from multi_agent.skills import save_skill
                from multi_agent.utils.errors import MultiAgentError

                payload = self._read_json()
                payload["id"] = skill_id
                logger.info("更新 skill id=%s", skill_id)
                saved = save_skill(payload, create=False)
                self._send_json(200, saved)
            except MultiAgentError as exc:
                self._send_json(400, {"error": str(exc)})
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write(traceback.format_exc())
                self._send_json(500, {"error": str(exc)})
            return

        if path == "/api/settings":
            try:
                _ensure_repo_path()
                from multi_agent.config import save_settings, settings_public_view

                payload = self._read_json()
                logger.info(
                    "更新 settings keys=%s",
                    sorted(k for k in payload.keys() if k != "api_key"),
                )
                save_settings(payload)
                self._send_json(200, settings_public_view())
            except ValueError as exc:
                self._send_json(400, {"error": str(exc)})
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write(traceback.format_exc())
                self._send_json(500, {"error": str(exc)})
            return

        self._send_json(404, {"error": "not found"})

    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        if path.startswith("/api/roles/"):
            role_id = path[len("/api/roles/") :].strip("/")
            try:
                _ensure_repo_path()
                from multi_agent.roles import delete_role
                from multi_agent.utils.errors import MultiAgentError

                logger.info("删除 role id=%s", role_id)
                delete_role(role_id)
                self._send_json(200, {"ok": True, "id": role_id})
            except MultiAgentError as exc:
                self._send_json(400, {"error": str(exc)})
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write(traceback.format_exc())
                self._send_json(500, {"error": str(exc)})
            return

        if path.startswith("/api/skills/"):
            skill_id = path[len("/api/skills/") :].strip("/")
            try:
                _ensure_repo_path()
                from multi_agent.skills import delete_skill
                from multi_agent.utils.errors import MultiAgentError

                logger.info("删除 skill id=%s", skill_id)
                delete_skill(skill_id)
                self._send_json(200, {"ok": True, "id": skill_id})
            except MultiAgentError as exc:
                self._send_json(400, {"error": str(exc)})
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write(traceback.format_exc())
                self._send_json(500, {"error": str(exc)})
            return

        self._send_json(404, {"error": "not found"})


def main() -> None:
    port = int(os.environ.get("MULTI_AGENT_WEB_PORT", "8765"))
    # 默认仅本机回环，配合 launchd，Cursor Simple Browser 可访问 127.0.0.1
    host = os.environ.get("MULTI_AGENT_WEB_HOST", "127.0.0.1")
    runs_root().mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"multi-agent web listening on http://{host}:{port}", flush=True)
    print(f"open http://127.0.0.1:{port}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("stopped", flush=True)


if __name__ == "__main__":
    main()
