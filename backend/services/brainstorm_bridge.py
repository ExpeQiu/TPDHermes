"""
头脑风暴桥接：调用独立的 TPD-multi-agent 圆桌引擎。

边界：
- multi-agent 自带 LLM / Agent 能力（Mock 或 Live 由其进程配置决定）
- Hermes 只做项目上下文、权限与参数透传，不代持 AI Key / 不转发 Hermes LLM
- 优先 HTTP（MULTI_AGENT_URL）；仅当本机可 resolve MULTI_AGENT_ROOT 或显式
  MULTI_AGENT_SDK_FALLBACK=true 时才 SDK 回退（生产容器通常无源码，避免误导报错）
- 轮询超时按 rounds 放大，并带 grace 收尾窗口，尽量收取已完成的 run
"""
from __future__ import annotations

import logging
import os
import sys
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx

logger = logging.getLogger("tpdx.hermes.brainstorm")

DEFAULT_PACK = "tech-ip"
DEFAULT_ROUNDS = 2
DEFAULT_DISCUSSION_MODE = "round_robin"
DEFAULT_HTTP_URL = "http://127.0.0.1:8765"
# 单次 HTTP 请求上限（health / progress / 最终结果）
HTTP_TIMEOUT_SEC = float(os.getenv("MULTI_AGENT_HTTP_TIMEOUT", "300"))
# 轮询总时长：max(BASE, rounds * PER_ROUND)；Live 圆桌常超过 300s
PROGRESS_TIMEOUT_BASE = float(
    os.getenv("MULTI_AGENT_PROGRESS_TIMEOUT_BASE", str(HTTP_TIMEOUT_SEC))
)
PROGRESS_TIMEOUT_PER_ROUND = float(
    os.getenv("MULTI_AGENT_PROGRESS_TIMEOUT_PER_ROUND", "90")
)
# 主超时后的收尾窗口：继续轮询 / 拉取已完成的 run（避免引擎已完成、job 已失败）
PROGRESS_GRACE_SEC = float(os.getenv("MULTI_AGENT_PROGRESS_GRACE_SEC", "120"))
PROGRESS_POLL_SEC = float(os.getenv("MULTI_AGENT_PROGRESS_POLL_SEC", "1.5"))
DISCUSSION_MODES = frozenset({"round_robin", "parallel", "debate"})

ProgressCallback = Callable[[dict[str, Any]], Awaitable[None] | None]


class BrainstormBridgeError(Exception):
    """桥接失败（配置 / 上游 / 执行）。"""


def _truthy(value: str | None) -> bool | None:
    if value is None:
        return None
    v = value.strip().lower()
    if v in {"1", "true", "yes", "on"}:
        return True
    if v in {"0", "false", "no", "off"}:
        return False
    return None


def resolve_progress_timeout(rounds: int, *, demo: bool | None = None) -> float:
    """
    Live 按轮次线性放大；Mock 可缩短。
    例：rounds=5 Live → max(300, 5*90)=450s。
    """
    r = max(1, int(rounds or DEFAULT_ROUNDS))
    if demo is True:
        per = min(PROGRESS_TIMEOUT_PER_ROUND, 25.0)
        base = min(PROGRESS_TIMEOUT_BASE, 120.0)
    else:
        per = PROGRESS_TIMEOUT_PER_ROUND
        base = PROGRESS_TIMEOUT_BASE
    return max(base, r * per)


def _sdk_fallback_allowed(*, prefer_http: bool | None) -> bool:
    """
    生产容器通常无源码树：默认仅在能 resolve MULTI_AGENT_ROOT 时才 SDK 回退。
    MULTI_AGENT_SDK_FALLBACK=false 可强制禁用；prefer_http=False 表示显式走 SDK。
    """
    if prefer_http is False:
        return True
    forced = _truthy(os.getenv("MULTI_AGENT_SDK_FALLBACK"))
    if forced is False:
        return False
    if forced is True:
        return True
    return resolve_multi_agent_root() is not None


def resolve_mock_hint(explicit: bool | None = None) -> bool | None:
    """
    仅作「提示」透传给 multi-agent，不在 Hermes 侧决定 Live 可用性。
    - explicit: UI 勾选 Mock
    - 否则读 MULTI_AGENT_MOCK_MODE（引擎侧环境约定），不读 Hermes API_KEY
    """
    if explicit is not None:
        return explicit
    return _truthy(os.getenv("MULTI_AGENT_MOCK_MODE"))


def resolve_mock_mode(explicit: bool | None = None) -> bool:
    """兼容旧调用：无提示时默认 True（避免误连）。"""
    hint = resolve_mock_hint(explicit)
    return True if hint is None else hint


def normalize_discussion_mode(value: str | None) -> str:
    raw = (value or DEFAULT_DISCUSSION_MODE).strip().lower().replace("-", "_")
    if raw == "roundrobin":
        raw = "round_robin"
    if raw not in DISCUSSION_MODES:
        logger.warning("未知 discussion_mode=%s，回退 %s", value, DEFAULT_DISCUSSION_MODE)
        return DEFAULT_DISCUSSION_MODE
    return raw


def resolve_multi_agent_root() -> Path | None:
    env = (os.getenv("MULTI_AGENT_ROOT") or "").strip()
    if env:
        p = Path(env).expanduser().resolve()
        if (p / "multi_agent").is_dir():
            return p
        logger.warning(
            "MULTI_AGENT_ROOT 无效（缺少 multi_agent 包）: %s，尝试 monorepo 候选路径",
            p,
        )

    hermes_root = Path(__file__).resolve().parents[2]
    candidates = [
        hermes_root / "TPD-multi-agent",  # monorepo：TPDHermes/TPD-multi-agent
        hermes_root / "vendor" / "TPD-multi-agent",
        hermes_root.parent / "TPD-multi-agent",
        hermes_root.parent.parent / "02 POC" / "TPD-multi-agent",  # 旧路径兼容
    ]
    for c in candidates:
        try:
            resolved = c.resolve()
        except OSError:
            continue
        if (resolved / "multi_agent").is_dir():
            return resolved
    return None


def multi_agent_http_base() -> str:
    return (os.getenv("MULTI_AGENT_URL") or DEFAULT_HTTP_URL).rstrip("/")


def _normalize_result(
    *,
    envelope: dict[str, Any] | None,
    delivery: str,
    trajectory: str,
    bridge: str,
    mock: bool | None,
) -> dict[str, Any]:
    env = envelope or {}
    delivery_obj = env.get("delivery") if isinstance(env.get("delivery"), dict) else {}
    meta = env.get("meta") if isinstance(env.get("meta"), dict) else {}
    title = ""
    body = delivery or ""
    if isinstance(delivery_obj, dict):
        title = str(delivery_obj.get("title") or "").strip()
        if not body:
            body = str(delivery_obj.get("body_markdown") or "").strip()
    if not title:
        title = "圆桌 Master Plan"
    mock_flag = mock
    if mock_flag is None:
        llm_mode = str(meta.get("llm_mode") or "").lower()
        mock_flag = llm_mode in {"demo", "mock"} or bool(meta.get("mock"))
    return {
        "run_id": env.get("run_id") or "",
        "mode": env.get("mode") or "roundtable",
        "coordinator": env.get("coordinator") or "主持人",
        "status": env.get("status") or "completed",
        "pack": meta.get("pack"),
        "discussion_mode": meta.get("discussion_mode"),
        "consensus_reached": meta.get("consensus_reached"),
        "consensus_score": meta.get("consensus_score"),
        "stopped_at_round": meta.get("stopped_at_round"),
        "title": title,
        "delivery_markdown": body,
        "trajectory_markdown": trajectory or "",
        "warnings": list(env.get("warnings") or []),
        "envelope": env,
        "meta": meta,
        "bridge": bridge,
        "mock": bool(mock_flag),
    }


async def _bundle_to_result(
    client: httpx.AsyncClient,
    base: str,
    run_id: str,
    *,
    progress: dict[str, Any] | None,
    demo: bool | None,
) -> dict[str, Any] | None:
    """若 run 已完成则拉取最终 bundle；未完成返回 None。"""
    prog = progress or {}
    status = str(prog.get("status") or "").lower()
    if status not in {"completed", "complete", "done"}:
        # 再查一次最终结果接口（progress 可能滞后）
        try:
            state_resp = await client.get(f"{base}/api/runs/{run_id}")
        except httpx.HTTPError:
            return None
        if state_resp.status_code >= 400:
            return None
        try:
            bundle_probe = state_resp.json()
        except Exception:
            return None
        env_probe = (
            bundle_probe.get("envelope")
            if isinstance(bundle_probe.get("envelope"), dict)
            else bundle_probe
        )
        st = ""
        if isinstance(env_probe, dict):
            st = str(env_probe.get("status") or "").lower()
        if st not in {"completed", "complete", "done"}:
            # 有 delivery 也视为可收
            delivery_probe = bundle_probe.get("delivery")
            if not delivery_probe and isinstance(env_probe, dict):
                delivery_probe = (env_probe.get("delivery") or {})
            body = ""
            if isinstance(delivery_probe, dict):
                body = str(delivery_probe.get("body_markdown") or "")
            elif isinstance(delivery_probe, str):
                body = delivery_probe
            if not body.strip():
                return None
        bundle = bundle_probe
    else:
        bundle_resp = await client.get(f"{base}/api/runs/{run_id}")
        if bundle_resp.status_code >= 400:
            raise BrainstormBridgeError(
                f"读取最终结果失败: HTTP {bundle_resp.status_code}"
            )
        bundle = bundle_resp.json()

    envelope = (
        bundle.get("envelope") if isinstance(bundle.get("envelope"), dict) else {}
    )
    if not envelope:
        envelope = {
            "run_id": run_id,
            "mode": "roundtable",
            "coordinator": "主持人",
            "status": "completed",
            "delivery": {
                "title": (prog.get("title") if prog else None) or "圆桌 Master Plan",
                "body_markdown": "",
            },
            "meta": {},
        }
    delivery = bundle.get("delivery") or ""
    if isinstance(delivery, dict):
        delivery = str(delivery.get("body_markdown") or "")
    trajectory = str(bundle.get("trajectory") or "")
    turns = prog.get("turns") if isinstance(prog.get("turns"), list) else []
    result = _normalize_result(
        envelope=envelope,
        delivery=str(delivery),
        trajectory=trajectory,
        bridge="http",
        mock=demo,
    )
    result["live_turns"] = turns
    return result


async def _run_via_http(
    topic: str,
    *,
    pack: str,
    rounds: int,
    discussion_mode: str,
    consensus_enabled: bool,
    consensus_threshold: float,
    debate_config: dict[str, Any] | None,
    moderator_enabled: bool,
    demo: bool | None,
    context: str | None = None,
    on_progress: ProgressCallback | None = None,
) -> dict[str, Any]:
    base = multi_agent_http_base()
    payload: dict[str, Any] = {
        "goal": topic,
        "mode": "roundtable",
        "pack": pack,
        "rounds": rounds,
        "discussion_mode": discussion_mode,
        "consensus_enabled": consensus_enabled,
        "consensus_threshold": consensus_threshold,
        "moderator_enabled": moderator_enabled,
        "knowledge_base": "none",
    }
    if debate_config:
        payload["debate_config"] = debate_config
    if demo is not None:
        payload["demo"] = demo
    ctx = (context or "").strip()
    if ctx:
        payload["context"] = ctx

    poll_timeout = resolve_progress_timeout(rounds, demo=demo)
    # 单次请求超时与轮询总时长解耦，避免长任务被 per-request timeout 误杀
    req_timeout = httpx.Timeout(
        max(60.0, min(HTTP_TIMEOUT_SEC, 120.0)),
        connect=10.0,
    )
    async with httpx.AsyncClient(timeout=req_timeout) as client:
        try:
            health = await client.get(f"{base}/api/health")
            if health.status_code != 200:
                raise BrainstormBridgeError(f"multi-agent 健康检查失败: HTTP {health.status_code}")
        except httpx.HTTPError as exc:
            raise BrainstormBridgeError(f"multi-agent 不可达: {exc}") from exc

        # 优先异步启动 + 轮询 progress（边跑边推发言）
        async_url = f"{base}/api/run/async"
        logger.info(
            "头脑风暴 HTTP 异步调用 | url=%s | pack=%s | rounds=%s | mode=%s | demo=%s | poll_timeout=%.0fs | topic=%s",
            async_url,
            pack,
            rounds,
            discussion_mode,
            demo,
            poll_timeout,
            topic[:80],
        )
        try:
            started = await client.post(async_url, json=payload)
        except httpx.HTTPError as exc:
            raise BrainstormBridgeError(f"multi-agent /api/run/async 不可达: {exc}") from exc

        if started.status_code == 404:
            logger.warning("multi-agent 无 /api/run/async，回退同步 /api/run")
            return await _run_via_http_sync(client, base, payload, demo=demo)

        if started.status_code >= 400:
            detail = started.text[:400]
            try:
                detail = str(started.json().get("error") or detail)
            except Exception:
                pass
            raise BrainstormBridgeError(f"multi-agent /api/run/async 失败: {detail}")

        started_body = started.json()
        run_id = str(started_body.get("run_id") or "").strip()
        if not run_id:
            raise BrainstormBridgeError("multi-agent 异步启动未返回 run_id")

        logger.info(
            "头脑风暴已异步启动 | run_id=%s | poll_timeout=%.0fs | grace=%.0fs",
            run_id,
            poll_timeout,
            PROGRESS_GRACE_SEC,
        )
        import asyncio

        deadline = time.monotonic() + poll_timeout
        grace_deadline = deadline + max(0.0, PROGRESS_GRACE_SEC)
        last_turn_count = -1
        last_progress: dict[str, Any] = {}

        async def _poll_once() -> dict[str, Any] | None:
            nonlocal last_turn_count, last_progress
            prog_resp = await client.get(f"{base}/api/runs/{run_id}/progress")
            if prog_resp.status_code == 404:
                return None
            if prog_resp.status_code >= 400:
                raise BrainstormBridgeError(
                    f"读取 progress 失败: HTTP {prog_resp.status_code}"
                )
            progress = prog_resp.json()
            last_progress = progress if isinstance(progress, dict) else {}
            turns = progress.get("turns") if isinstance(progress.get("turns"), list) else []
            status = str(progress.get("status") or "running")
            if len(turns) != last_turn_count:
                last_turn_count = len(turns)
                logger.info(
                    "头脑风暴进度 | run_id=%s | status=%s | turns=%s",
                    run_id,
                    status,
                    len(turns),
                )
                if on_progress:
                    maybe = on_progress(
                        {
                            "run_id": run_id,
                            "status": status,
                            "turns": turns,
                            "title": progress.get("title"),
                            "topic": progress.get("topic"),
                            "error": progress.get("error"),
                        }
                    )
                    if asyncio.iscoroutine(maybe):
                        await maybe

            if status == "failed":
                raise BrainstormBridgeError(
                    str(progress.get("error") or f"圆桌失败 run_id={run_id}")
                )
            if status in {"completed", "complete", "done"}:
                done = await _bundle_to_result(
                    client, base, run_id, progress=progress, demo=demo
                )
                if done:
                    return done
            return None

        while time.monotonic() < deadline:
            done = await _poll_once()
            if done:
                return done
            await asyncio.sleep(PROGRESS_POLL_SEC)

        # 主超时：先尝试直接收已完成结果，再进入 grace 收尾窗口
        logger.warning(
            "头脑风暴主轮询超时，尝试收尾 | run_id=%s | turns=%s | grace=%.0fs",
            run_id,
            last_turn_count,
            PROGRESS_GRACE_SEC,
        )
        salvaged = await _bundle_to_result(
            client, base, run_id, progress=last_progress or None, demo=demo
        )
        if salvaged:
            logger.info("头脑风暴超时后成功收取已完成结果 | run_id=%s", run_id)
            salvaged.setdefault("warnings", [])
            if isinstance(salvaged["warnings"], list):
                salvaged["warnings"].append("progress_poll_timeout_salvaged")
            return salvaged

        while time.monotonic() < grace_deadline:
            done = await _poll_once()
            if done:
                logger.info("头脑风暴 grace 窗口内完成 | run_id=%s", run_id)
                return done
            salvaged = await _bundle_to_result(
                client, base, run_id, progress=last_progress or None, demo=demo
            )
            if salvaged:
                logger.info("头脑风暴 grace 窗口内收取结果 | run_id=%s", run_id)
                return salvaged
            await asyncio.sleep(PROGRESS_POLL_SEC)

        raise BrainstormBridgeError(
            f"轮询 progress 超时 run_id={run_id} "
            f"(limit={poll_timeout:.0f}s+grace={PROGRESS_GRACE_SEC:.0f}s, "
            f"last_turns={max(last_turn_count, 0)}, rounds={rounds})"
        )


async def _run_via_http_sync(
    client: httpx.AsyncClient,
    base: str,
    payload: dict[str, Any],
    *,
    demo: bool | None,
) -> dict[str, Any]:
    url = f"{base}/api/run"
    logger.info("头脑风暴 HTTP 同步调用 | url=%s", url)
    resp = await client.post(url, json=payload)
    if resp.status_code >= 400:
        detail = resp.text[:400]
        try:
            detail = str(resp.json().get("error") or detail)
        except Exception:
            pass
        raise BrainstormBridgeError(f"multi-agent /api/run 失败: {detail}")
    data = resp.json()
    envelope = data.get("envelope") if isinstance(data.get("envelope"), dict) else data
    delivery = data.get("delivery") or ""
    if isinstance(delivery, dict):
        delivery = str(delivery.get("body_markdown") or "")
    trajectory = str(data.get("trajectory") or "")
    return _normalize_result(
        envelope=envelope if isinstance(envelope, dict) else {},
        delivery=str(delivery),
        trajectory=trajectory,
        bridge="http",
        mock=demo,
    )


def _run_via_sdk_sync(
    topic: str,
    *,
    pack: str,
    rounds: int,
    discussion_mode: str,
    consensus_enabled: bool,
    consensus_threshold: float,
    debate_config: dict[str, Any] | None,
    moderator_enabled: bool,
    demo: bool | None,
    context: str | None = None,
) -> dict[str, Any]:
    root = resolve_multi_agent_root()
    if root is None:
        raise BrainstormBridgeError(
            "未找到 TPD-multi-agent：请设置 MULTI_AGENT_ROOT，或启动 multi-agent Web（MULTI_AGENT_URL）"
        )
    root_s = str(root)
    if root_s not in sys.path:
        sys.path.insert(0, root_s)
        logger.info("已注入 MULTI_AGENT_ROOT 到 sys.path: %s", root_s)

    from multi_agent.config import load_settings
    from multi_agent.sdk import Client

    # SDK 回退：demo 仅作提示；Key / Live 仍由 multi-agent load_settings 决定
    settings = load_settings(demo=demo, pack=pack)
    if demo is not None:
        settings.mock_mode = bool(demo)
    client = Client(settings=settings)
    ctx = (context or "").strip() or None
    logger.info(
        "头脑风暴 SDK 调用 | root=%s | pack=%s | rounds=%s | mode=%s | consensus=%s | mock=%s | context_chars=%s | topic=%s",
        root_s,
        pack,
        rounds,
        discussion_mode,
        consensus_enabled,
        settings.mock_mode,
        len(ctx or ""),
        topic[:80],
    )
    envelope = client.roundtable(
        topic,
        pack=pack,
        rounds=rounds,
        discussion_mode=discussion_mode,
        consensus_enabled=consensus_enabled,
        consensus_threshold=consensus_threshold,
        debate_config=debate_config,
        moderator_enabled=moderator_enabled,
        context=ctx,
    )
    run_id = str(envelope.get("run_id") or "")
    trajectory = ""
    if run_id:
        try:
            trajectory = client.trajectory(run_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("读取轨迹失败 run_id=%s: %s", run_id, exc)
    delivery_obj = envelope.get("delivery") if isinstance(envelope.get("delivery"), dict) else {}
    body = ""
    if isinstance(delivery_obj, dict):
        body = str(delivery_obj.get("body_markdown") or "")
    return _normalize_result(
        envelope=envelope if isinstance(envelope, dict) else {},
        delivery=body,
        trajectory=trajectory,
        bridge="sdk",
        mock=settings.mock_mode,
    )


async def run_roundtable(
    topic: str,
    *,
    pack: str = DEFAULT_PACK,
    rounds: int = DEFAULT_ROUNDS,
    demo: bool | None = None,
    prefer_http: bool | None = None,
    discussion_mode: str = DEFAULT_DISCUSSION_MODE,
    consensus_enabled: bool = False,
    consensus_threshold: float = 0.7,
    debate_config: dict[str, Any] | None = None,
    moderator_enabled: bool = True,
    context: str | None = None,
    on_progress: ProgressCallback | None = None,
) -> dict[str, Any]:
    topic = (topic or "").strip()
    if not topic:
        raise BrainstormBridgeError("议题不能为空")
    pack = (pack or DEFAULT_PACK).strip() or DEFAULT_PACK
    rounds = max(1, min(int(rounds or DEFAULT_ROUNDS), 5))
    discussion_mode = normalize_discussion_mode(discussion_mode)
    consensus_threshold = max(0.5, min(1.0, float(consensus_threshold or 0.7)))
    demo_hint = resolve_mock_hint(demo)
    context_s = (context or "").strip() or None

    use_http = prefer_http
    if use_http is None:
        use_http = True  # 默认优先独立 Web 引擎

    http_error: BrainstormBridgeError | None = None
    if use_http:
        try:
            return await _run_via_http(
                topic,
                pack=pack,
                rounds=rounds,
                discussion_mode=discussion_mode,
                consensus_enabled=consensus_enabled,
                consensus_threshold=consensus_threshold,
                debate_config=debate_config,
                moderator_enabled=moderator_enabled,
                demo=demo_hint,
                context=context_s,
                on_progress=on_progress,
            )
        except BrainstormBridgeError as exc:
            http_error = exc
            logger.warning("头脑风暴 HTTP 失败: %s", exc)

    if not _sdk_fallback_allowed(prefer_http=prefer_http):
        if http_error is not None:
            # 保留真实 HTTP 原因，避免被「未找到 TPD-multi-agent」掩盖
            raise http_error
        raise BrainstormBridgeError(
            "multi-agent HTTP 未启用，且未允许 SDK 回退（设置 MULTI_AGENT_URL 或 MULTI_AGENT_ROOT）"
        )

    import asyncio

    try:
        return await asyncio.to_thread(
            _run_via_sdk_sync,
            topic,
            pack=pack,
            rounds=rounds,
            discussion_mode=discussion_mode,
            consensus_enabled=consensus_enabled,
            consensus_threshold=consensus_threshold,
            debate_config=debate_config,
            moderator_enabled=moderator_enabled,
            demo=demo_hint if demo_hint is not None else True,
            context=context_s,
        )
    except BrainstormBridgeError as sdk_exc:
        if http_error is not None:
            raise BrainstormBridgeError(f"{http_error}；SDK 回退失败: {sdk_exc}") from sdk_exc
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("头脑风暴 SDK 执行失败")
        parts = [str(http_error)] if http_error else []
        parts.append(str(exc))
        raise BrainstormBridgeError("；".join(parts) if parts else f"圆桌执行失败: {exc}") from exc


async def health_check() -> dict[str, Any]:
    base = multi_agent_http_base()
    http_ok = False
    http_error = None
    upstream_mock: bool | None = None
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{base}/api/health")
            http_ok = resp.status_code == 200
            if not http_ok:
                http_error = f"HTTP {resp.status_code}"
            else:
                try:
                    body = resp.json()
                    if isinstance(body, dict) and "mock" in body:
                        upstream_mock = bool(body.get("mock"))
                    elif isinstance(body, dict) and "llm_mode" in body:
                        upstream_mock = str(body.get("llm_mode")).lower() in {
                            "demo",
                            "mock",
                        }
                except Exception:
                    pass
    except Exception as exc:  # noqa: BLE001
        http_error = str(exc)

    root = resolve_multi_agent_root()
    mock_default = (
        upstream_mock if upstream_mock is not None else (resolve_mock_hint(None) is not False)
    )
    return {
        "http_url": base,
        "http_ok": http_ok,
        "http_error": http_error,
        "sdk_root": str(root) if root else None,
        "sdk_ok": root is not None,
        "mock_default": mock_default,
        "ai_owner": "multi-agent",
        "ready": http_ok or root is not None,
    }
