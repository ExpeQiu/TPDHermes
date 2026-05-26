"""对话轮次统计（基于 chat 编排 run）。"""
from __future__ import annotations

import json
import logging
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.orchestration_run import OrchestrationRun

logger = logging.getLogger("tpdx.hermes.conversation_metrics")

SESSION_IDLE_MINUTES = 30


def _loads(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _parse_ts(raw: str | None) -> datetime | None:
    text = (raw or "").strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def count_rounds_from_request(request_json: str | None) -> int:
    """单次 chat 请求累计轮次（含当前 user_message）。"""
    req = _loads(request_json)
    msgs = req.get("messages")
    current = 1 if (req.get("user_message") or "").strip() else 0
    if isinstance(msgs, list) and msgs:
        prior_users = sum(
            1 for m in msgs if isinstance(m, dict) and (m.get("role") or "").strip() == "user"
        )
        return prior_users + current
    return current


def _has_prior_messages(request_json: str | None) -> bool:
    req = _loads(request_json)
    msgs = req.get("messages")
    return isinstance(msgs, list) and len(msgs) > 0


def session_total_rounds(request_json_list: list[str]) -> int:
    """推断单个会话的总轮次。"""
    if not request_json_list:
        return 0
    per_run = [count_rounds_from_request(raw) for raw in request_json_list]
    max_rounds = max(per_run) if per_run else 0
    if max_rounds > 1 or any(_has_prior_messages(raw) for raw in request_json_list):
        return max_rounds
    return sum(1 for n in per_run if n >= 1)


def _session_key_from_run(run: OrchestrationRun) -> tuple[str, str, str]:
    req = _loads(run.request_json)
    user_id = (run.user_id or req.get("user_id") or "default").strip() or "default"
    project_id = (run.project_id or req.get("project_id") or "").strip()
    scenario_id = (run.scenario_id or req.get("scenario_id") or "general").strip() or "general"
    return user_id, project_id, scenario_id


@dataclass
class _ChatSessionBucket:
    requests: list[str] = field(default_factory=list)
    last_ts: datetime | None = None
    last_date: str = ""


async def build_conversation_metrics(
    db: AsyncSession,
    *,
    since: str,
) -> dict[str, Any]:
    runs = (
        await db.execute(
            select(OrchestrationRun).where(
                OrchestrationRun.entrypoint == "chat",
                OrchestrationRun.created_at >= since,
            ).order_by(OrchestrationRun.created_at)
        )
    ).scalars().all()

    idle_seconds = SESSION_IDLE_MINUTES * 60
    sessions: list[_ChatSessionBucket] = []
    current: _ChatSessionBucket | None = None
    current_key: tuple[str, str, str] | None = None

    for run in runs:
        ts = _parse_ts(run.created_at)
        if ts is None:
            continue
        key = _session_key_from_run(run)
        req_json = run.request_json or "{}"
        day = (run.created_at or "")[:10]

        if (
            current is None
            or current_key != key
            or current.last_ts is None
            or (ts - current.last_ts).total_seconds() > idle_seconds
        ):
            current = _ChatSessionBucket(requests=[req_json], last_ts=ts, last_date=day)
            sessions.append(current)
            current_key = key
        else:
            current.requests.append(req_json)
            current.last_ts = ts
            current.last_date = day

    session_rounds: list[int] = []
    daily_sessions: dict[str, list[int]] = defaultdict(list)

    for bucket in sessions:
        rounds = session_total_rounds(bucket.requests)
        session_rounds.append(rounds)
        if bucket.last_date and rounds > 0:
            daily_sessions[bucket.last_date].append(rounds)

    chat_run_count = len(runs)
    chat_session_count = len(session_rounds)
    positive_rounds = [r for r in session_rounds if r > 0]
    avg_rounds = (
        round(sum(positive_rounds) / len(positive_rounds), 2) if positive_rounds else None
    )
    max_rounds = max(positive_rounds) if positive_rounds else 0

    daily_rows = [
        {
            "date": day,
            "session_count": len(rounds_list),
            "avg_rounds": round(sum(rounds_list) / len(rounds_list), 2) if rounds_list else 0.0,
        }
        for day, rounds_list in sorted(daily_sessions.items())
    ]

    logger.info(
        "conversation_metrics since=%s runs=%s sessions=%s avg_rounds=%s",
        since,
        chat_run_count,
        chat_session_count,
        avg_rounds,
    )

    return {
        "chat_run_count": chat_run_count,
        "chat_session_count": chat_session_count,
        "avg_conversation_rounds": avg_rounds,
        "max_conversation_rounds": max_rounds,
        "daily_conversation": daily_rows,
    }
