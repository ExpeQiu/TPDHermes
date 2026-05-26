"""Skills 调用次数与采纳率聚合（编排 run + 反馈）。"""
from __future__ import annotations

import json
import logging
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.feedback_event import FeedbackEvent
from backend.models.orchestration_run import OrchestrationRun
from backend.models.output_asset import OutputAsset

logger = logging.getLogger("tpdx.hermes.skill_metrics")

ADOPTION_LEVELS = frozenset({"full", "partial", "reject", "unknown"})


def _loads(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _first_skill_name(values: Any) -> str | None:
    if not isinstance(values, list):
        return None
    for item in values:
        name = str(item or "").strip()
        if name:
            return name
    return None


def resolve_run_skill_name(run: OrchestrationRun) -> str | None:
    """从编排 run 解析主 skill 名称。"""
    policy = _loads(run.skills_policy_json)
    skill = _first_skill_name(policy.get("allowed")) or _first_skill_name(policy.get("preferred"))
    if skill:
        return skill

    request = _loads(run.request_json)
    overrides = request.get("overrides") if isinstance(request.get("overrides"), dict) else {}
    skills_override = overrides.get("skills") if isinstance(overrides.get("skills"), dict) else {}
    skill = _first_skill_name(skills_override.get("allowed")) or _first_skill_name(
        skills_override.get("preferred")
    )
    if skill:
        return skill

    capture = _loads(run.tool_capture_json)
    for artifact in capture.get("artifacts") or []:
        if not isinstance(artifact, dict):
            continue
        name = str(artifact.get("skill") or "").strip()
        if name:
            return name
    return None


def _calc_adoption_rate(levels: dict[str, int]) -> float | None:
    total = sum(levels.values())
    if not total:
        return None
    full = int(levels.get("full", 0))
    partial = int(levels.get("partial", 0))
    return round((full + partial * 0.5) / total, 4)


@dataclass
class SkillMetricsAccumulator:
    call_count: int = 0
    users: set[str] = field(default_factory=set)
    adoption_levels: dict[str, int] = field(default_factory=lambda: defaultdict(int))

    def add_call(self, user_id: str | None) -> None:
        self.call_count += 1
        self.users.add((user_id or "").strip() or "default")

    def add_adoption(self, level: str) -> None:
        key = level if level in ADOPTION_LEVELS else "unknown"
        self.adoption_levels[key] += 1


async def _resolve_skill_for_feedback(
    db: AsyncSession,
    *,
    run_id: str | None,
    output_id: str | None,
    run_skill_cache: dict[str, str | None],
) -> str | None:
    rid = (run_id or "").strip()
    if rid:
        if rid not in run_skill_cache:
            run = await db.get(OrchestrationRun, rid)
            run_skill_cache[rid] = resolve_run_skill_name(run) if run else None
        return run_skill_cache[rid]

    oid = (output_id or "").strip()
    if oid:
        out = await db.get(OutputAsset, oid)
        if out and (out.run_id or "").strip():
            return await _resolve_skill_for_feedback(
                db,
                run_id=out.run_id,
                output_id=None,
                run_skill_cache=run_skill_cache,
            )
    return None


async def build_skill_metrics(
    db: AsyncSession,
    *,
    since: str,
    top: int = 20,
) -> dict[str, Any]:
    runs = (
        await db.execute(
            select(OrchestrationRun).where(
                OrchestrationRun.entrypoint == "workshop",
                OrchestrationRun.created_at >= since,
            )
        )
    ).scalars().all()

    by_skill: dict[str, SkillMetricsAccumulator] = defaultdict(SkillMetricsAccumulator)
    run_skill_cache: dict[str, str | None] = {}

    for run in runs:
        skill = resolve_run_skill_name(run)
        if not skill:
            continue
        run_skill_cache[run.id] = skill
        by_skill[skill].add_call(run.user_id)

    feedback_rows = (
        await db.execute(select(FeedbackEvent).where(FeedbackEvent.created_at >= since))
    ).scalars().all()
    for fb in feedback_rows:
        skill = await _resolve_skill_for_feedback(
            db,
            run_id=fb.run_id,
            output_id=fb.output_id,
            run_skill_cache=run_skill_cache,
        )
        if skill:
            by_skill[skill].add_adoption(fb.adoption_level or "unknown")

    rows: list[dict[str, Any]] = []
    total_calls = 0
    overall_levels: dict[str, int] = defaultdict(int)

    for skill_name, acc in by_skill.items():
        total_calls += acc.call_count
        feedback_count = sum(acc.adoption_levels.values())
        for level, count in acc.adoption_levels.items():
            overall_levels[level] += count
        rows.append(
            {
                "skill_name": skill_name,
                "call_count": acc.call_count,
                "user_count": len(acc.users),
                "feedback_count": feedback_count,
                "adoption_rate": _calc_adoption_rate(dict(acc.adoption_levels)),
                "full_count": int(acc.adoption_levels.get("full", 0)),
                "partial_count": int(acc.adoption_levels.get("partial", 0)),
                "reject_count": int(acc.adoption_levels.get("reject", 0)),
            }
        )

    rows.sort(key=lambda r: (r["call_count"], r["feedback_count"]), reverse=True)
    rows = rows[:top]

    overall_feedback = sum(overall_levels.values())
    logger.info(
        "skill_metrics since=%s skills=%s total_calls=%s feedback=%s",
        since,
        len(by_skill),
        total_calls,
        overall_feedback,
    )

    return {
        "skills_total_calls": total_calls,
        "skills_feedback_count": overall_feedback,
        "skills_overall_adoption_rate": _calc_adoption_rate(dict(overall_levels)),
        "skill_usage": rows,
    }
