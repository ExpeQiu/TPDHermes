"""
学习决策服务：从反馈聚类生成 learning_signals 与周报。
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.feedback_event import FeedbackEvent
from backend.models.learning_report import LearningReport
from backend.models.learning_signal import LearningSignal
from backend.services.feedback_service import feedback_stats

logger = logging.getLogger("tpdx.hermes.learning")

HINTS_PATH = Path(os.getenv("TPD_LEARNING_HINTS_PATH", "./data/tpd_learning_hints.json")).resolve()
SIGNAL_STATUSES = frozenset({"open", "ack", "dismissed"})
SIGNAL_RESOLVE_STATUSES = frozenset({"ack", "dismissed"})

SIGNAL_TYPES = frozenset(
    {
        "repeated_correction",
        "low_adoption_scenario",
        "kb_miss",
        "skill_underused",
    }
)


async def analyze_feedbacks(db: AsyncSession, *, days: int = 14) -> list[LearningSignal]:
    """扫描近期反馈，生成/更新 learning_signals。"""
    since = (datetime.now() - timedelta(days=max(1, min(days, 60)))).isoformat()
    rows = (
        await db.execute(
            select(FeedbackEvent)
            .where(FeedbackEvent.created_at >= since)
            .order_by(desc(FeedbackEvent.created_at))
        )
    ).scalars().all()

    signals: list[LearningSignal] = []
    now = datetime.now().isoformat()

    # 规则1：同场景 reject >= 2 → repeated_correction
    scenario_rejects: Counter[str] = Counter()
    scenario_reasons: dict[str, list[str]] = defaultdict(list)
    for fb in rows:
        if fb.adoption_level == "reject" and fb.scenario_id:
            scenario_rejects[fb.scenario_id] += 1
            if fb.reason_text:
                scenario_reasons[fb.scenario_id].append(fb.reason_text[:120])

    for scenario_id, count in scenario_rejects.items():
        if count < 2:
            continue
        sig = await _upsert_signal(
            db,
            signal_type="repeated_correction",
            entity_kind="scenario",
            entity_id=scenario_id,
            entity_label=scenario_id,
            count=count,
            payload={
                "reason_samples": scenario_reasons.get(scenario_id, [])[:5],
                "suggestion": "建议更新该场景 Skill 模板或输出策略",
            },
            now=now,
        )
        signals.append(sig)

    # 规则2：场景采纳率 < 50% 且样本 >= 3 → low_adoption_scenario
    scenario_totals: Counter[str] = Counter()
    scenario_positive: Counter[str] = Counter()
    for fb in rows:
        if not fb.scenario_id:
            continue
        scenario_totals[fb.scenario_id] += 1
        if fb.adoption_level in ("full", "partial"):
            scenario_positive[fb.scenario_id] += 1

    for scenario_id, total in scenario_totals.items():
        if total < 3:
            continue
        rate = scenario_positive[scenario_id] / total
        if rate >= 0.5:
            continue
        sig = await _upsert_signal(
            db,
            signal_type="low_adoption_scenario",
            entity_kind="scenario",
            entity_id=scenario_id,
            entity_label=scenario_id,
            count=total,
            payload={
                "adoption_rate": round(rate, 3),
                "positive": scenario_positive[scenario_id],
                "total": total,
                "suggestion": "建议复核模板约束与知识范围",
            },
            now=now,
        )
        signals.append(sig)

    # 规则3：rewrite 反应 >= 2 同项目 → repeated_correction on project
    project_rewrites: Counter[str] = Counter()
    for fb in rows:
        if fb.reaction_type == "rewrite" and fb.project_id:
            project_rewrites[fb.project_id] += 1

    for project_id, count in project_rewrites.items():
        if count < 2:
            continue
        sig = await _upsert_signal(
            db,
            signal_type="repeated_correction",
            entity_kind="project",
            entity_id=project_id,
            entity_label=project_id,
            count=count,
            payload={
                "rewrite_count": count,
                "suggestion": "建议检查项目默认模板与术语策略",
            },
            now=now,
        )
        signals.append(sig)

    await db.commit()
    logger.info("learning analyze complete signals=%s", len(signals))
    return signals


async def _upsert_signal(
    db: AsyncSession,
    *,
    signal_type: str,
    entity_kind: str,
    entity_id: str,
    entity_label: str,
    count: int,
    payload: dict[str, Any],
    now: str,
) -> LearningSignal:
    existing = (
        await db.execute(
            select(LearningSignal).where(
                LearningSignal.signal_type == signal_type,
                LearningSignal.entity_kind == entity_kind,
                LearningSignal.entity_id == entity_id,
                LearningSignal.status == "open",
            )
        )
    ).scalar_one_or_none()

    if existing:
        existing.count = count
        existing.last_seen_at = now
        existing.payload_json = json.dumps(payload, ensure_ascii=False)
        return existing

    row = LearningSignal(
        id=str(uuid.uuid4()),
        signal_type=signal_type,
        entity_kind=entity_kind,
        entity_id=entity_id,
        entity_label=entity_label,
        count=count,
        status="open",
        payload_json=json.dumps(payload, ensure_ascii=False),
        last_seen_at=now,
    )
    db.add(row)
    return row


async def list_open_signals(db: AsyncSession, *, limit: int = 50) -> list[LearningSignal]:
    result = await db.execute(
        select(LearningSignal)
        .where(LearningSignal.status == "open")
        .order_by(desc(LearningSignal.last_seen_at))
        .limit(min(limit, 100))
    )
    return list(result.scalars().all())


async def get_signal_by_id(db: AsyncSession, signal_id: str) -> LearningSignal | None:
    result = await db.execute(select(LearningSignal).where(LearningSignal.id == signal_id))
    return result.scalar_one_or_none()


async def update_signal_status(
    db: AsyncSession,
    signal_id: str,
    *,
    status: str,
) -> LearningSignal | None:
    """将学习信号标记为已处理（ack）或忽略（dismissed）。"""
    if status not in SIGNAL_RESOLVE_STATUSES:
        raise ValueError(f"invalid signal status: {status}")

    row = await get_signal_by_id(db, signal_id)
    if not row:
        return None
    if row.status != "open":
        return row

    row.status = status
    row.last_seen_at = datetime.now().isoformat()
    await db.commit()
    await db.refresh(row)
    logger.info(
        "learning signal resolved id=%s type=%s entity=%s status=%s",
        row.id,
        row.signal_type,
        row.entity_id,
        status,
    )
    return row


async def export_learning_hints(db: AsyncSession) -> None:
    """导出开放学习信号供 Curator / 运维读取。"""
    try:
        signals = await list_open_signals(db, limit=50)
        payload = {
            "updated_at": datetime.now().isoformat(),
            "signals": [signal_to_dict(s) for s in signals],
        }
        HINTS_PATH.parent.mkdir(parents=True, exist_ok=True)
        HINTS_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        logger.debug("learning hints exported path=%s count=%s", HINTS_PATH, len(signals))
    except Exception:
        logger.exception("learning hints export failed")


async def generate_weekly_report(db: AsyncSession) -> LearningReport:
    """生成本周学习摘要。"""
    now = datetime.now()
    week_start = (now - timedelta(days=now.weekday())).strftime("%Y-%m-%d")
    stats = await feedback_stats(db, days=7)
    signals = await list_open_signals(db, limit=30)

    learned: list[str] = []
    pending: list[str] = []
    for fb_row in (
        await db.execute(
            select(FeedbackEvent)
            .where(
                FeedbackEvent.created_at >= (now - timedelta(days=7)).isoformat(),
                FeedbackEvent.adoption_level == "full",
            )
            .order_by(desc(FeedbackEvent.created_at))
            .limit(10)
        )
    ).scalars():
        scene = fb_row.scenario_id or "general"
        learned.append(f"场景 {scene} 获得采纳反馈")

    for sig in signals[:10]:
        payload = {}
        if sig.payload_json:
            try:
                payload = json.loads(sig.payload_json)
            except json.JSONDecodeError:
                pass
        suggestion = payload.get("suggestion", sig.signal_type)
        pending.append(f"[{sig.signal_type}] {sig.entity_label}: {suggestion}")

    summary = {
        "week_start": week_start,
        "feedback_stats": stats,
        "learned": learned[:5],
        "pending_confirmations": pending[:8],
        "open_signals_count": len(signals),
        "generated_at": now.isoformat(),
    }

    report = LearningReport(
        id=str(uuid.uuid4()),
        user_id="default",
        week_start=week_start,
        summary_json=json.dumps(summary, ensure_ascii=False),
    )
    db.add(report)
    await db.commit()
    await db.refresh(report)
    logger.info("weekly learning report id=%s week=%s", report.id, week_start)
    return report


async def get_latest_report(db: AsyncSession) -> LearningReport | None:
    result = await db.execute(
        select(LearningReport).order_by(desc(LearningReport.created_at)).limit(1)
    )
    return result.scalar_one_or_none()


def signal_to_dict(sig: LearningSignal) -> dict[str, Any]:
    payload = None
    if sig.payload_json:
        try:
            payload = json.loads(sig.payload_json)
        except json.JSONDecodeError:
            payload = sig.payload_json
    return {
        "id": sig.id,
        "signal_type": sig.signal_type,
        "entity_kind": sig.entity_kind,
        "entity_id": sig.entity_id,
        "entity_label": sig.entity_label,
        "count": sig.count,
        "status": sig.status,
        "payload": payload,
        "last_seen_at": sig.last_seen_at,
    }


async def record_kb_miss(
    db: AsyncSession,
    *,
    query: str,
    collection: str,
    project_id: str | None = None,
) -> None:
    """KB 零命中时记录学习信号。"""
    term = (query or "").strip()[:80]
    if not term:
        return
    entity_id = f"{collection}:{term}"
    existing = (
        await db.execute(
            select(LearningSignal).where(
                LearningSignal.signal_type == "kb_miss",
                LearningSignal.entity_id == entity_id,
                LearningSignal.status == "open",
            )
        )
    ).scalar_one_or_none()
    count = int(existing.count or 1) + 1 if existing else 1
    await _upsert_signal(
        db,
        signal_type="kb_miss",
        entity_kind="kb_term",
        entity_id=entity_id,
        entity_label=term,
        count=count,
        payload={
            "query": term,
            "collection": collection,
            "project_id": project_id,
            "suggestion": "建议补充知识库条目",
        },
        now=datetime.now().isoformat(),
    )
    await db.commit()
    logger.info("kb_miss recorded collection=%s query=%s count=%s", collection, term, count)


async def kb_miss_rate(db: AsyncSession, *, days: int = 7) -> float:
    since = (datetime.now() - timedelta(days=max(1, min(days, 90)))).isoformat()
    miss_count = (
        await db.execute(
            select(func.count(LearningSignal.id)).where(
                LearningSignal.signal_type == "kb_miss",
                LearningSignal.last_seen_at >= since,
            )
        )
    ).scalar() or 0
    fb_total = (
        await db.execute(
            select(func.count(FeedbackEvent.id)).where(FeedbackEvent.created_at >= since)
        )
    ).scalar() or 0
    if fb_total == 0:
        return 0.0 if miss_count == 0 else 1.0
    return round(int(miss_count) / int(fb_total), 4)
