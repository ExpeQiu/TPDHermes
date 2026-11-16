"""头脑风暴圆桌：席位仍用专家团配置，发言与收束走已绑定内核。"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx
import yaml

from backend.services.brainstorm_bridge import (
    BrainstormBridgeError,
    ProgressCallback,
    _normalize_result,
    resolve_multi_agent_root,
)
from backend.services.kernel_binding import install_model, read_binding, resolve_chat_upstream
from backend.services.kernel_model_probe import (
    _DEFAULT_BASE,
    _endpoint,
    _resolve_key,
    _wire,
)

logger = logging.getLogger("tpdx.hermes.brainstorm.kernel")

_FALLBACK_ROLES: dict[str, dict[str, str]] = {
    "ip_strategist": {
        "name": "IP策略师",
        "perspective": "IP全案、矩阵货架、命名定位、技术品牌与车型互锁",
        "system": "你是IP策略师。交付核心受众、技术主张、差异化依据和推荐方案。",
    },
    "brand_researcher": {
        "name": "品牌调研官",
        "perspective": "调研洞察、趋势判断、竞品对标证据",
        "system": "你是品牌调研官。用可核对的证据说话，缺证据时明确写出缺口。",
    },
    "comm_planner": {
        "name": "传播策划官",
        "perspective": "传播目标、受众分层、节奏ROADMAP、认证权益",
        "system": "你是传播策划官。给出受众、节奏和可执行传播动作。",
    },
    "moderator": {
        "name": "主持人",
        "perspective": "议题推进、证据分歧、决策与行动项",
        "system": "你是技术包装圆桌主持人。整理决策、分歧、行动项和待确认事项。",
    },
}


def kernel_status() -> dict[str, Any]:
    upstream = resolve_chat_upstream()
    binding = read_binding() or {}
    url = str(upstream.get("url") or "").strip()
    status = {
        "ready": bool(url),
        "source": str(upstream.get("source") or "env"),
        "kernel_id": str(binding.get("kernel_id") or ""),
    }
    logger.info(
        "brainstorm kernel status ready=%s source=%s kernel_id=%s",
        status["ready"],
        status["source"],
        status["kernel_id"] or "-",
    )
    return status


def _load_yaml(path: Path) -> dict[str, Any]:
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except OSError as exc:
        logger.warning("brainstorm pack unreadable path=%s err=%s", path, exc)
        return {}
    return data if isinstance(data, dict) else {}


def load_roundtable_roles(pack: str) -> list[dict[str, str]]:
    """读取专家团席位。文件缺失时用内置席位，保证内核路径仍可发言。"""
    root = resolve_multi_agent_root()
    pack_id = (pack or "tech-ip").strip() or "tech-ip"
    seats: list[dict[str, Any]] = []
    if root is not None:
        pack_file = root / "multi_agent" / "skill_packs" / pack_id.replace("-", "_") / "pack.yml"
        pack_data = _load_yaml(pack_file) if pack_file.is_file() else {}
        raw_seats = pack_data.get("roundtable_roles")
        if isinstance(raw_seats, list):
            seats = [row for row in raw_seats if isinstance(row, dict)]
    if not seats:
        logger.info("brainstorm kernel roles fallback pack=%s", pack_id)
        seats = [{"id": rid} for rid in ("ip_strategist", "brand_researcher", "comm_planner", "moderator")]

    roles: list[dict[str, str]] = []
    for seat in seats:
        role_id = str(seat.get("id") or "").strip()
        if not role_id:
            continue
        catalog: dict[str, Any] = {}
        if root is not None:
            role_file = root / "multi_agent" / "roles" / f"{role_id}.yml"
            if role_file.is_file():
                catalog = _load_yaml(role_file)
        fallback = _FALLBACK_ROLES.get(role_id, {})
        roles.append(
            {
                "id": role_id,
                "name": str(seat.get("name") or catalog.get("name") or fallback.get("name") or role_id),
                "perspective": str(
                    seat.get("perspective") or catalog.get("perspective") or fallback.get("perspective") or ""
                ),
                "system": str(catalog.get("system") or fallback.get("system") or f"你是{role_id}。"),
            }
        )
    if not roles:
        raise BrainstormBridgeError(f"专家团 {pack_id} 没有可用席位")
    logger.info("brainstorm kernel roles pack=%s count=%s", pack_id, len(roles))
    return roles


def _clip(text: str, limit: int = 12000) -> str:
    body = (text or "").strip()
    if len(body) <= limit:
        return body
    return body[-limit:]


def _parse_consensus(text: str, threshold: float) -> tuple[bool, float | None, str]:
    match = re.search(r"\{[\s\S]*\}", text or "")
    if not match:
        return False, None, (text or "").strip()
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return False, None, (text or "").strip()
    if not isinstance(data, dict):
        return False, None, (text or "").strip()
    score_raw = data.get("score")
    score: float | None
    try:
        score = float(score_raw) if score_raw is not None else None
    except (TypeError, ValueError):
        score = None
    if score is not None and score > 1:
        score = score / 10.0
    reached = bool(data.get("reached")) or (score is not None and score >= threshold)
    note = str(data.get("note") or "").strip() or (text or "").strip()
    return reached, score, note


def _message_text(payload: dict[str, Any]) -> str:
    blocks = payload.get("content")
    if isinstance(blocks, list):
        parts = [
            str(block.get("text") or "")
            for block in blocks
            if isinstance(block, dict) and block.get("type") in {None, "text"}
        ]
        text = "\n".join(part for part in parts if part.strip())
        if text.strip():
            return text.strip()
    choices = payload.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        message = choices[0].get("message")
        if isinstance(message, dict):
            return str(message.get("content") or "").strip()
    return ""


async def complete_kernel_turn(messages: list[dict[str, str]], *, max_tokens: int = 700) -> str:
    """用绑定内核的模型直接生成一句发言，不进入带工具的代理循环。"""
    binding = read_binding()
    if not binding or not binding.get("root"):
        raise BrainstormBridgeError("内核未就绪：请在配置中绑定本机内核")
    root = Path(binding["root"])
    profile = install_model(str(binding.get("kernel_id") or ""), root)
    provider = str(profile.get("provider") or "").strip()
    model = str(profile.get("model") or "").strip()
    base = str(profile.get("base_url") or "").strip() or _DEFAULT_BASE.get(provider, "")
    secret, key_source = _resolve_key(provider, "", root / ".env")
    if not model or not base or not secret:
        logger.warning(
            "brainstorm kernel model incomplete provider=%s model_set=%s base_set=%s key_source=%s",
            provider or "-",
            bool(model),
            bool(base),
            key_source or "-",
        )
        raise BrainstormBridgeError("内核模型未配置完整，无法发言")

    wire = _wire(provider, base)
    url = _endpoint(base, wire)
    system = "\n\n".join(item["content"] for item in messages if item.get("role") == "system")
    dialogue = [
        {"role": item["role"], "content": item["content"]}
        for item in messages
        if item.get("role") in {"user", "assistant"} and str(item.get("content") or "").strip()
    ]
    headers = {"Content-Type": "application/json"}
    if wire == "anthropic_messages":
        headers["x-api-key"] = secret
        headers["anthropic-version"] = "2023-06-01"
        payload: dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": dialogue or [{"role": "user", "content": "请发言"}],
        }
        if system:
            payload["system"] = system
    else:
        headers["Authorization"] = f"Bearer {secret}"
        payload = {"model": model, "max_tokens": max_tokens, "messages": messages}
    host = urlparse(url).hostname or "-"
    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(45.0), trust_env=False) as client:
            response = await client.post(url, headers=headers, json=payload)
    except httpx.HTTPError as exc:
        logger.warning(
            "brainstorm kernel model transport failed host=%s wire=%s err=%s",
            host,
            wire,
            exc.__class__.__name__,
        )
        raise BrainstormBridgeError(f"内核模型不可用：{exc.__class__.__name__}") from exc
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    if response.status_code >= 400:
        logger.warning(
            "brainstorm kernel model status=%s host=%s wire=%s elapsed_ms=%s",
            response.status_code,
            host,
            wire,
            elapsed_ms,
        )
        raise BrainstormBridgeError(f"内核模型失败：HTTP {response.status_code}")
    try:
        data = response.json()
    except json.JSONDecodeError as exc:
        raise BrainstormBridgeError("内核模型返回的不是 JSON") from exc
    text = _message_text(data if isinstance(data, dict) else {})
    if not text:
        raise BrainstormBridgeError("内核模型返回空正文")
    logger.info(
        "brainstorm kernel model ok host=%s wire=%s model=%s elapsed_ms=%s chars=%s",
        host,
        wire,
        model,
        elapsed_ms,
        len(text),
    )
    return text


async def _speak(messages: list[dict[str, str]], *, role_id: str, round_no: int, max_tokens: int = 700) -> str:
    try:
        content = await complete_kernel_turn(messages, max_tokens=max_tokens)
    except BrainstormBridgeError:
        logger.warning("brainstorm kernel speak failed role=%s round=%s", role_id, round_no)
        raise
    logger.info(
        "brainstorm kernel speak role=%s round=%s chars=%s",
        role_id,
        round_no,
        len(content),
    )
    return content


def _messages(role: dict[str, str], *, topic: str, context: str | None, instruction: str, prior: str) -> list[dict[str, str]]:
    system = (
        f"{role['system'].strip()}\n"
        f"你的视角：{role['perspective'] or '本席位专业判断'}。\n"
        "只写本席位的发言，不要代替其他角色，不要输出 Master Plan 全文。\n"
        "资料不足时写明缺口，不要编造来源。"
    )
    user = "\n\n".join(
        [
            f"议题:\n{topic}",
            f"参考材料:\n{context or '（无）'}",
            f"此前发言:\n{prior or '（无）'}",
            instruction,
        ]
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


async def run_kernel_roundtable(
    topic: str,
    *,
    pack: str,
    rounds: int,
    discussion_mode: str,
    consensus_enabled: bool,
    consensus_threshold: float,
    debate_config: dict[str, Any] | None,
    moderator_enabled: bool,
    context: str | None,
    on_progress: ProgressCallback | None = None,
) -> dict[str, Any]:
    status = kernel_status()
    if not status["ready"]:
        raise BrainstormBridgeError("内核未就绪：请在配置中绑定本机内核，或配置对话上游")

    roles = load_roundtable_roles(pack)
    by_id = {role["id"]: role for role in roles}
    moderator = by_id.get("moderator") if moderator_enabled else None
    experts = [role for role in roles if role["id"] != "moderator"]
    if not experts:
        raise BrainstormBridgeError("专家团没有专家席位")

    debate = debate_config if isinstance(debate_config, dict) else {}
    pro_ids = [str(item) for item in (debate.get("pro_role_ids") or []) if str(item) in by_id]
    con_ids = [str(item) for item in (debate.get("con_role_ids") or []) if str(item) in by_id]
    judge_id = str(debate.get("judge_role_id") or "moderator")
    if discussion_mode == "debate":
        if not pro_ids or not con_ids:
            mid = max(1, len(experts) // 2)
            pro_ids = [role["id"] for role in experts[:mid]]
            con_ids = [role["id"] for role in experts[mid:]] or [experts[-1]["id"]]
        judge = by_id.get(judge_id) or moderator or experts[0]
    else:
        judge = moderator

    run_id = "kernel-" + uuid.uuid4().hex[:12]
    turns: list[dict[str, str]] = []
    transcript: list[str] = []
    consensus_reached = False
    consensus_score: float | None = None
    stopped_at = rounds

    async def publish(title: str | None = None, activity: str | None = None) -> None:
        if on_progress is None:
            return
        payload = {
            "run_id": run_id,
            "title": title or "圆桌进行中",
            "turns": list(turns),
            "activity": activity or "",
        }
        maybe = on_progress(payload)
        if asyncio.iscoroutine(maybe):
            await maybe

    async def add_turn(role: dict[str, str], *, kind: str, badge: str, content: str, round_no: int) -> None:
        text = content.strip()
        turns.append(
            {
                "id": f"{run_id}-r{round_no}-{role['id']}-{len(turns) + 1}",
                "kind": kind,
                "speaker": role["name"],
                "badge": badge,
                "content": text,
            }
        )
        transcript.append(f"**{role['name']}**（{badge}）：{text}")
        await publish()

    async def ask(role: dict[str, str], instruction: str, *, kind: str, badge: str, round_no: int) -> str:
        await publish(activity=f"{role['name']}正在发言")
        content = await _speak(
            _messages(
                role,
                topic=topic,
                context=context,
                instruction=instruction,
                prior=_clip("\n\n".join(transcript)),
            ),
            role_id=role["id"],
            round_no=round_no,
        )
        await add_turn(role, kind=kind, badge=badge, content=content, round_no=round_no)
        return content

    logger.info(
        "brainstorm kernel start run_id=%s pack=%s mode=%s rounds=%s source=%s",
        run_id,
        pack,
        discussion_mode,
        rounds,
        status["source"],
    )

    if moderator is not None:
        await ask(
            moderator,
            "用三四句话开场：点明议题、本轮要做的决定，并请专家从各自视角发言。",
            kind="opening",
            badge="开场",
            round_no=0,
        )

    for round_no in range(1, rounds + 1):
        if discussion_mode == "debate":
            sequence = (
                [(by_id[rid], "正方", "speech") for rid in pro_ids]
                + [(by_id[rid], "反方", "speech") for rid in con_ids]
            )
            for role, badge, kind in sequence:
                stance = "论证支持立场，并回应对方质疑。" if badge == "正方" else "提出质疑与风险，并挑战正方主张。"
                await ask(
                    role,
                    f"这是第 {round_no} 轮。你属于{badge}。{stance}给出核心观点和一条行动。",
                    kind=kind,
                    badge=f"R{round_no} · {badge}",
                    round_no=round_no,
                )
            if judge is not None:
                await ask(
                    judge,
                    f"这是第 {round_no} 轮。点评本轮正反方，指出证据强弱和一条改进。不要提前写完整 Master Plan。",
                    kind="escalate",
                    badge=f"R{round_no} · 裁判",
                    round_no=round_no,
                )
        elif discussion_mode == "parallel":
            async def parallel_turn(role: dict[str, str]) -> tuple[dict[str, str], str]:
                await publish(activity=f"{role['name']}正在发言")
                content = await _speak(
                    _messages(
                        role,
                        topic=topic,
                        context=context,
                        instruction=f"这是第 {round_no} 轮。给出本视角的核心判断和一条行动。不要复述其他角色。",
                        prior=_clip("\n\n".join(transcript)),
                    ),
                    role_id=role["id"],
                    round_no=round_no,
                )
                return role, content

            results = await asyncio.gather(*(parallel_turn(role) for role in experts))
            for role, content in results:
                await add_turn(role, kind="speech", badge=f"R{round_no}", content=content, round_no=round_no)
            if moderator is not None:
                await ask(
                    moderator,
                    f"这是第 {round_no} 轮。归纳本轮分歧和已对齐的点，先不要写完整 Master Plan。",
                    kind="escalate",
                    badge=f"R{round_no} · 主持",
                    round_no=round_no,
                )
        else:
            for role in experts:
                await ask(
                    role,
                    f"这是第 {round_no} 轮。按你的视角回应此前发言，给出核心判断和一条行动。",
                    kind="speech",
                    badge=f"R{round_no}",
                    round_no=round_no,
                )
            if moderator is not None:
                await ask(
                    moderator,
                    f"这是第 {round_no} 轮。点出尚未解决的分歧，并压成可执行问题。不要写完整 Master Plan。",
                    kind="escalate",
                    badge=f"R{round_no} · 主持",
                    round_no=round_no,
                )

        if consensus_enabled and judge is not None:
            await publish(activity=f"{judge['name']}正在判断共识")
            verdict = await _speak(
                _messages(
                    judge,
                    topic=topic,
                    context=context,
                    instruction=(
                        "只输出一个 JSON 对象，不要 Markdown。"
                        '格式：{"score": 0到1的小数, "reached": true或false, "note": "一句话"}。'
                        f"score 表示当前是否足以收束，达到 {consensus_threshold:.1f} 才能 reached=true。"
                    ),
                    prior=_clip("\n\n".join(transcript)),
                ),
                role_id=judge["id"],
                round_no=round_no,
            )
            reached, score, note = _parse_consensus(verdict, consensus_threshold)
            consensus_score = score
            await add_turn(
                judge,
                kind="consensus",
                badge=f"R{round_no} · 共识",
                content=note,
                round_no=round_no,
            )
            logger.info(
                "brainstorm kernel consensus run_id=%s round=%s reached=%s score=%s",
                run_id,
                round_no,
                reached,
                score,
            )
            if reached:
                consensus_reached = True
                stopped_at = round_no
                break

    closer = moderator or experts[0]
    await publish(activity=f"{closer['name']}正在整理 Master Plan")
    delivery = await _speak(
        [
            {
                "role": "system",
                "content": (
                    f"{closer['system']}\n"
                    "把圆桌收成唯一 Master Plan。用 Markdown，包含决策、行动项、验收标准和待确认事项。"
                    "不要编造未在发言中出现的数据。"
                ),
            },
            {
                "role": "user",
                "content": f"议题:\n{topic}\n\n讨论记录:\n{_clip(chr(10).join(transcript), 16000)}",
            },
        ],
        role_id=closer["id"],
        round_no=stopped_at,
        max_tokens=1200,
    )
    await add_turn(closer, kind="synthesis", badge="Master Plan", content=delivery, round_no=stopped_at)

    envelope = {
        "run_id": run_id,
        "mode": "roundtable",
        "coordinator": (moderator or closer)["name"],
        "status": "completed",
        "delivery": {"title": "圆桌 Master Plan", "body_markdown": delivery},
        "meta": {
            "pack": pack,
            "discussion_mode": discussion_mode,
            "consensus_reached": consensus_reached if consensus_enabled else None,
            "consensus_score": consensus_score,
            "stopped_at_round": stopped_at,
            "llm_mode": "kernel",
        },
    }
    result = _normalize_result(
        envelope=envelope,
        delivery=delivery,
        trajectory="\n\n".join(transcript),
        bridge="kernel",
        mock=False,
    )
    result["live_turns"] = turns
    logger.info(
        "brainstorm kernel done run_id=%s turns=%s stopped_at=%s consensus=%s chars=%s",
        run_id,
        len(turns),
        stopped_at,
        consensus_reached,
        len(delivery),
    )
    return result
