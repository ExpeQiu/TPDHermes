"""
头脑风暴桥接：调用独立的 TPD-multi-agent 圆桌引擎。

边界：
- multi-agent 自带 LLM / Agent 能力（Mock 或 Live 由其进程配置决定）
- Hermes 只做项目上下文、权限与参数透传，不代持 AI Key / 不转发 Hermes LLM
- 优先 HTTP（MULTI_AGENT_URL）；不可达时才 SDK 回退（仍使用 multi-agent 包内配置）
"""
from __future__ import annotations

import logging
import os
import sys
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger("tpdx.hermes.brainstorm")

DEFAULT_PACK = "nev-tech"
DEFAULT_ROUNDS = 2
DEFAULT_DISCUSSION_MODE = "round_robin"
DEFAULT_HTTP_URL = "http://127.0.0.1:8765"
HTTP_TIMEOUT_SEC = float(os.getenv("MULTI_AGENT_HTTP_TIMEOUT", "300"))
DISCUSSION_MODES = frozenset({"round_robin", "parallel", "debate"})


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
        logger.warning("MULTI_AGENT_ROOT 无效（缺少 multi_agent 包）: %s", p)
        return None

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

    url = f"{base}/api/run"
    logger.info(
        "头脑风暴 HTTP 调用 | url=%s | pack=%s | rounds=%s | mode=%s | consensus=%s | demo=%s | context_chars=%s | topic=%s",
        url,
        pack,
        rounds,
        discussion_mode,
        consensus_enabled,
        demo,
        len(ctx),
        topic[:80],
    )
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT_SEC) as client:
        try:
            health = await client.get(f"{base}/api/health")
            if health.status_code != 200:
                raise BrainstormBridgeError(f"multi-agent 健康检查失败: HTTP {health.status_code}")
        except httpx.HTTPError as exc:
            raise BrainstormBridgeError(f"multi-agent 不可达: {exc}") from exc

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

    errors: list[str] = []
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
            )
        except BrainstormBridgeError as exc:
            errors.append(str(exc))
            logger.warning("头脑风暴 HTTP 失败，尝试 SDK: %s", exc)

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
    except BrainstormBridgeError:
        raise
    except Exception as exc:  # noqa: BLE001
        errors.append(str(exc))
        logger.exception("头脑风暴 SDK 执行失败")
        raise BrainstormBridgeError(
            "；".join(errors) if errors else f"圆桌执行失败: {exc}"
        ) from exc


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
