"""学习计划：白天入队，0:00–5:00 逐条执行，7 天后验收或回滚。"""

from __future__ import annotations

import json
import logging
import os
import shutil
import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import desc, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.experience_entry import ExperienceEntry
from backend.models.feedback_event import FeedbackEvent
from backend.models.learning_signal import LearningSignal
from backend.models.learning_task import LearningTask
from backend.models.orchestration_run import OrchestrationRun
from backend.models.scenario_profile import ScenarioProfile
from backend.services.kb_contract import TPD_EXPERIENCE_COLLECTION
from backend.services.kb_entry_manage import delete_kb_entry
from backend.services.kb_write import add_kb_harvest_entry
from backend.services.skill_evolution import (
    MAX_ACTIONS,
    EvolutionAction,
    apply_actions,
    collect_evolution,
)
from backend.services.skill_lifecycle import SkillLifecycleService
from backend.services.skill_loader import SkillLoader, SkillNotFoundError
from backend.services.skill_version import bump_version

logger = logging.getLogger("tpdx.hermes.learning_plan")

APPLY_KINDS = frozenset({"patch_skill", "create_skill", "fill_kb", "tune_scenario"})
OPEN_STATUSES = frozenset({"confirmed", "running", "verifying"})
VERIFY_AFTER_DAYS = 7
MAX_ATTEMPTS = 3


def plan_enabled() -> bool:
    return os.getenv("LEARNING_PLAN_ENABLED", "true").lower() in ("1", "true", "yes")


def _window_minutes() -> tuple[int, int]:
    raw = os.getenv("LEARNING_PLAN_WINDOW", "00:00-05:00").strip()
    try:
        start_raw, end_raw = raw.split("-", 1)
        start_h, start_m = (int(part) for part in start_raw.split(":", 1))
        end_h, end_m = (int(part) for part in end_raw.split(":", 1))
        start = start_h * 60 + start_m
        end = end_h * 60 + end_m
    except ValueError:
        logger.warning("learning_plan window invalid raw=%s fallback=00:00-05:00", raw)
        return 0, 5 * 60
    if start == end:
        return 0, 5 * 60
    return start, end


def in_night_window(now: datetime | None = None) -> bool:
    if not plan_enabled():
        return False
    start, end = _window_minutes()
    current = now or datetime.now()
    minutes = current.hour * 60 + current.minute
    if start < end:
        return start <= minutes < end
    return minutes >= start or minutes < end


def _loads(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _dump(data: dict[str, Any]) -> str:
    return json.dumps(data, ensure_ascii=False)


def _night_key(now: datetime) -> str:
    return now.strftime("%Y-%m-%d")


def _due(raw: str | None, now: datetime) -> bool:
    if not raw:
        return True
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return True
    if parsed.tzinfo is not None:
        parsed = parsed.replace(tzinfo=None)
    return parsed <= now


def task_to_dict(row: LearningTask) -> dict[str, Any]:
    acceptance = _loads(row.acceptance_json)
    return {
        "id": row.id,
        "dedupe_key": row.dedupe_key,
        "kind": row.kind,
        "status": row.status,
        "target_kind": row.target_kind,
        "target_id": row.target_id,
        "summary": row.summary,
        "signal_type": row.signal_type,
        "rule_id": row.rule_id,
        "acceptance": acceptance,
        "due_at": row.due_at,
        "parent_id": row.parent_id,
        "night_key": row.night_key,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


async def list_plan(db: AsyncSession, *, limit: int = 50) -> list[dict[str, Any]]:
    rows = (
        await db.execute(
            select(LearningTask).order_by(desc(LearningTask.created_at)).limit(min(max(limit, 1), 100))
        )
    ).scalars().all()
    return [task_to_dict(row) for row in rows]


async def _blocked(db: AsyncSession, dedupe_key: str, night_key: str) -> bool:
    rows = (
        await db.execute(
            select(LearningTask)
            .where(LearningTask.dedupe_key == dedupe_key)
            .order_by(desc(LearningTask.created_at))
        )
    ).scalars().all()
    for row in rows:
        if row.status in OPEN_STATUSES:
            return True
        if row.status == "done":
            return True
        if row.status == "rolled_back" and (row.night_key or "") == night_key:
            return True
    return False


async def _insert_task(
    db: AsyncSession,
    *,
    dedupe_key: str,
    kind: str,
    target_kind: str,
    target_id: str,
    summary: str,
    signal_type: str | None,
    rule_id: str | None,
    payload: dict[str, Any],
    evidence: list[str] | None,
    due_at: str,
    night_key: str,
    parent_id: str | None = None,
    status: str = "confirmed",
) -> LearningTask | None:
    if await _blocked(db, dedupe_key, night_key):
        logger.info(
            "learning_plan enqueue skipped dedupe_key=%s kind=%s reason=open_or_done",
            dedupe_key,
            kind,
        )
        return None
    now = datetime.now().isoformat()
    row = LearningTask(
        id=str(uuid.uuid4()),
        dedupe_key=dedupe_key,
        kind=kind,
        status=status,
        target_kind=target_kind,
        target_id=target_id,
        summary=summary,
        signal_type=signal_type,
        rule_id=rule_id,
        payload_json=_dump(payload),
        evidence_json=_dump({"ids": evidence or []}),
        due_at=due_at,
        parent_id=parent_id,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    await db.flush()
    logger.info(
        "learning_plan enqueued task_id=%s dedupe_key=%s kind=%s target_id=%s",
        row.id,
        dedupe_key,
        kind,
        target_id,
    )
    return row


def _scenario_line(signal: LearningSignal, payload: dict[str, Any]) -> str:
    if signal.signal_type == "skill_underused":
        name = str(payload.get("skill") or signal.entity_id or "").strip()
        return f"优先使用技能 {name}"
    if signal.signal_type == "low_adoption_scenario":
        rate = payload.get("adoption_rate")
        if isinstance(rate, (int, float)):
            return f"收紧输出：当前采纳率 {rate}"
        return "收紧该场景的输出约束"
    samples = payload.get("reason_samples")
    if isinstance(samples, list):
        for item in samples:
            text = str(item or "").strip()
            if len(text) >= 8:
                return text[:180]
    return f"避免场景 {signal.entity_label or signal.entity_id} 被重复拒绝"


async def enqueue_learning_plan(db: AsyncSession, *, days: int = 14, now: datetime | None = None) -> dict[str, Any]:
    """把达标技能动作和开放信号收成任务。不写技能、知识库或场景。"""
    if not plan_enabled():
        logger.info("learning_plan disabled")
        return {"enabled": False, "enqueued": 0, "items": []}
    moment = now or datetime.now()
    night_key = _night_key(moment)
    due = moment.isoformat()
    created: list[LearningTask] = []

    mined = await collect_evolution(db, days=days)
    for action in mined.get("actions") or []:
        kind = "create_skill" if action.action == "create" else "patch_skill"
        row = await _insert_task(
            db,
            dedupe_key=f"{kind}:{action.rule_id}",
            kind=kind,
            target_kind="skill",
            target_id=action.skill_name,
            summary=f"{'新建' if kind == 'create_skill' else '改写'}技能 {action.skill_name}：{action.rule}",
            signal_type="skill_rule",
            rule_id=action.rule_id,
            payload={
                "rule": action.rule,
                "rule_id": action.rule_id,
                "support": action.support,
                "evidence_ids": action.evidence_ids,
                "skill_name": action.skill_name,
                "action": action.action,
            },
            evidence=action.evidence_ids,
            due_at=due,
            night_key=night_key,
        )
        if row:
            created.append(row)

    signals = (
        await db.execute(
            select(LearningSignal).where(LearningSignal.status == "open").order_by(desc(LearningSignal.last_seen_at))
        )
    ).scalars().all()
    for signal in signals:
        payload = _loads(signal.payload_json)
        if signal.signal_type == "kb_miss":
            query = str(payload.get("query") or signal.entity_label or "").strip()
            collection = str(payload.get("collection") or TPD_EXPERIENCE_COLLECTION).strip()
            if not query:
                continue
            row = await _insert_task(
                db,
                dedupe_key=f"fill_kb:{collection}:{query}",
                kind="fill_kb",
                target_kind="kb",
                target_id=signal.entity_id or query,
                summary=f"补齐知识：{query}",
                signal_type="kb_miss",
                rule_id=None,
                payload={
                    "query": query,
                    "collection": collection,
                    "count": int(signal.count or 1),
                    "signal_id": signal.id,
                    "project_id": signal.project_id,
                },
                evidence=[signal.id],
                due_at=due,
                night_key=night_key,
            )
            if row:
                created.append(row)
            continue
        scenario_id = ""
        if signal.signal_type in ("repeated_correction", "low_adoption_scenario") and signal.entity_kind == "scenario":
            scenario_id = str(signal.entity_id or "").strip()
        elif signal.signal_type == "skill_underused":
            scenario_id = str(payload.get("scenario_id") or "").strip()
        if not scenario_id:
            continue
        line = _scenario_line(signal, payload)
        row = await _insert_task(
            db,
            dedupe_key=f"tune_scenario:{signal.signal_type}:{scenario_id}:{signal.entity_id or ''}",
            kind="tune_scenario",
            target_kind="scenario",
            target_id=scenario_id,
            summary=f"调整场景 {scenario_id}：{line}",
            signal_type=signal.signal_type,
            rule_id=None,
            payload={
                "scenario_id": scenario_id,
                "line": line,
                "signal_id": signal.id,
                "skill": payload.get("skill") or signal.entity_id,
                "adoption_rate": payload.get("adoption_rate"),
            },
            evidence=[signal.id],
            due_at=due,
            night_key=night_key,
        )
        if row:
            created.append(row)

    await db.commit()
    logger.info("learning_plan enqueue complete enqueued=%s night_key=%s", len(created), night_key)
    return {"enabled": True, "enqueued": len(created), "items": [task_to_dict(row) for row in created]}


async def _measure(db: AsyncSession, acceptance: dict[str, Any]) -> float:
    metric = str(acceptance.get("metric") or "")
    since = (datetime.now() - timedelta(days=VERIFY_AFTER_DAYS)).isoformat()
    scenario_id = str(acceptance.get("scenario_id") or "").strip()
    if metric == "adoption_rate":
        query = select(FeedbackEvent.adoption_level).where(FeedbackEvent.created_at >= since)
        if scenario_id:
            query = query.where(FeedbackEvent.scenario_id == scenario_id)
        levels = (await db.execute(query)).scalars().all()
        if not levels:
            return 0.0
        full = sum(1 for level in levels if level == "full")
        partial = sum(1 for level in levels if level == "partial")
        return round((full + partial * 0.5) / len(levels), 4)
    if metric == "reject_count":
        query = select(func.count(FeedbackEvent.id)).where(
            FeedbackEvent.created_at >= since,
            FeedbackEvent.adoption_level == "reject",
        )
        if scenario_id:
            query = query.where(FeedbackEvent.scenario_id == scenario_id)
        return float((await db.execute(query)).scalar() or 0)
    if metric == "kb_miss_count":
        entity_id = str(acceptance.get("entity_id") or "")
        row = (
            await db.execute(
                select(LearningSignal).where(
                    LearningSignal.signal_type == "kb_miss",
                    LearningSignal.entity_id == entity_id,
                    LearningSignal.status == "open",
                )
            )
        ).scalar_one_or_none()
        return float(row.count or 0) if row else 0.0
    if metric == "skill_calls":
        skill = str(acceptance.get("skill") or "")
        if not skill:
            return 0.0
        runs = (
            await db.execute(
                select(OrchestrationRun.response_metadata_json, OrchestrationRun.tool_capture_json).where(
                    OrchestrationRun.created_at >= since,
                    OrchestrationRun.status == "completed",
                )
            )
        ).all()
        total = 0
        for meta_raw, tool_raw in runs:
            for blob in (meta_raw, tool_raw):
                data = _loads(blob)
                calls = data.get("skill_calls")
                if isinstance(calls, list):
                    for item in calls:
                        name = ""
                        if isinstance(item, dict):
                            name = str(item.get("skill_name") or item.get("skill") or "")
                        elif isinstance(item, str):
                            name = item
                        if name == skill:
                            total += 1
                used = data.get("used_skills")
                if isinstance(used, list) and skill in {str(item) for item in used}:
                    total += 1
        return float(total)
    return 0.0


def _improved(acceptance: dict[str, Any], before: float, after: float) -> bool:
    if str(acceptance.get("better") or "") == "higher":
        return after > before
    return after < before


async def _night_apply_count(db: AsyncSession, night_key: str) -> int:
    rows = (
        await db.execute(
            select(LearningTask.id).where(
                LearningTask.night_key == night_key,
                LearningTask.kind.in_(tuple(APPLY_KINDS)),
                LearningTask.status.in_(("running", "verifying", "done", "rolled_back")),
            )
        )
    ).all()
    return len(rows)


async def _pick_task(db: AsyncSession, now: datetime, night_key: str) -> LearningTask | None:
    rows = (
        await db.execute(select(LearningTask).where(LearningTask.status == "confirmed"))
    ).scalars().all()
    due = [row for row in rows if _due(row.due_at, now)]
    spent = await _night_apply_count(db, night_key)

    def sort_key(row: LearningTask) -> tuple[int, int, str]:
        payload = _loads(row.payload_json)
        support = int(payload.get("support") or 0)
        if row.kind == "verify":
            rank = 0
        elif row.kind in APPLY_KINDS:
            rank = 1
        else:
            rank = 2
        return (rank, -support, row.created_at or "")

    for row in sorted(due, key=sort_key):
        if row.kind in APPLY_KINDS and spent >= MAX_ACTIONS:
            continue
        return row
    return None


def _touch(row: LearningTask, status: str) -> None:
    row.status = status
    row.updated_at = datetime.now().isoformat()


async def _acceptance_for(task: LearningTask, db: AsyncSession) -> dict[str, Any]:
    payload = _loads(task.payload_json)
    if task.kind in ("patch_skill", "create_skill"):
        return {"metric": "adoption_rate", "better": "higher"}
    if task.kind == "fill_kb":
        return {
            "metric": "kb_miss_count",
            "better": "lower",
            "entity_id": task.target_id,
            "query": payload.get("query"),
            "collection": payload.get("collection"),
        }
    signal_type = task.signal_type or ""
    if signal_type == "low_adoption_scenario":
        return {"metric": "adoption_rate", "better": "higher", "scenario_id": task.target_id}
    if signal_type == "skill_underused":
        return {
            "metric": "skill_calls",
            "better": "higher",
            "skill": payload.get("skill"),
            "scenario_id": task.target_id,
        }
    return {"metric": "reject_count", "better": "lower", "scenario_id": task.target_id}


async def _mark_attempts(task: LearningTask, reason: str) -> str:
    payload = _loads(task.payload_json)
    attempts = int(payload.get("attempts") or 0) + 1
    payload["attempts"] = attempts
    payload["last_error"] = reason
    task.payload_json = _dump(payload)
    if attempts >= MAX_ATTEMPTS:
        _touch(task, "rolled_back")
        return "rolled_back"
    _touch(task, "confirmed")
    return "retry"


async def _schedule_verify(db: AsyncSession, parent: LearningTask, now: datetime, baseline: dict[str, Any], acceptance: dict[str, Any]) -> None:
    parent.baseline_json = _dump(baseline)
    parent.acceptance_json = _dump(acceptance)
    _touch(parent, "verifying")
    due = (now + timedelta(days=VERIFY_AFTER_DAYS)).isoformat()
    child = LearningTask(
        id=str(uuid.uuid4()),
        dedupe_key=f"verify:{parent.id}",
        kind="verify",
        status="confirmed",
        target_kind=parent.target_kind,
        target_id=parent.target_id,
        summary=f"验收：{parent.summary or parent.target_id}",
        signal_type=parent.signal_type,
        rule_id=parent.rule_id,
        baseline_json=parent.baseline_json,
        acceptance_json=parent.acceptance_json,
        payload_json=_dump({"parent_id": parent.id}),
        due_at=due,
        parent_id=parent.id,
        created_at=now.isoformat(),
        updated_at=now.isoformat(),
    )
    db.add(child)
    logger.info(
        "learning_plan verify scheduled task_id=%s parent_id=%s dedupe_key=%s kind=%s due_at=%s",
        child.id,
        parent.id,
        child.dedupe_key,
        parent.kind,
        due,
    )


async def _apply_skill(db: AsyncSession, task: LearningTask, loader: SkillLoader) -> dict[str, Any]:
    payload = _loads(task.payload_json)
    action = EvolutionAction(
        action="create" if task.kind == "create_skill" else "patch",
        skill_name=str(payload.get("skill_name") or task.target_id or ""),
        rule=str(payload.get("rule") or ""),
        rule_id=str(payload.get("rule_id") or task.rule_id or ""),
        support=int(payload.get("support") or 1),
        evidence_ids=list(payload.get("evidence_ids") or []),
    )
    lifecycle = SkillLifecycleService(db, loader)
    existing = await lifecycle._get_db_skill(action.skill_name)
    version_before = existing.version if existing else None
    applied = await apply_actions(db, [action], loader)
    patched = applied.get("patched") or []
    created = applied.get("created") or []
    skipped = applied.get("skipped") or []
    if patched or created:
        return {
            "status": "applied",
            "created": bool(created),
            "version_before": version_before,
            "version_after": (patched or created)[0].get("version"),
        }
    reason = str((skipped[0] or {}).get("reason") or "skipped") if skipped else "skipped"
    if reason == "duplicate":
        return {"status": "duplicate", "version_before": version_before}
    return {"status": "failed", "reason": reason, "version_before": version_before}


async def _apply_kb(db: AsyncSession, task: LearningTask) -> dict[str, Any]:
    payload = _loads(task.payload_json)
    if payload.get("doc_id"):
        return {"status": "applied", "doc_id": payload.get("doc_id"), "experience_id": payload.get("experience_id")}
    query = str(payload.get("query") or "").strip()
    collection = str(payload.get("collection") or TPD_EXPERIENCE_COLLECTION).strip() or TPD_EXPERIENCE_COLLECTION
    count = int(payload.get("count") or 1)
    content = f"查询：{query}\n空命中：{count} 次\n建议补齐与该查询对应的知识条目。"
    title = f"待补：{query}"[:120]
    result = await add_kb_harvest_entry(
        collection_name=collection,
        project_id=str(payload.get("project_id") or "__all__"),
        title=title,
        content=content,
        summary=content[:280],
        domain="internal_methodology",
        source="learning_plan",
        published=False,
        metadata={"learning_task_id": task.id, "query": query, "source_type": "learning_plan"},
    )
    if not result.get("ok") and collection != TPD_EXPERIENCE_COLLECTION:
        logger.info(
            "learning_plan fill_kb fallback task_id=%s collection=%s message=%s",
            task.id,
            collection,
            result.get("message"),
        )
        collection = TPD_EXPERIENCE_COLLECTION
        result = await add_kb_harvest_entry(
            collection_name=collection,
            project_id=str(payload.get("project_id") or "__all__"),
            title=title,
            content=content,
            summary=content[:280],
            domain="internal_methodology",
            source="learning_plan",
            published=False,
            metadata={"learning_task_id": task.id, "query": query, "source_type": "learning_plan"},
        )
    if not result.get("ok"):
        return {"status": "failed", "reason": str(result.get("message") or "kb_write_failed")}
    doc_id = str(result.get("doc_id") or "")
    entry = ExperienceEntry(
        id=str(uuid.uuid4()),
        project_id=payload.get("project_id"),
        scenario_tags_json=json.dumps(["learning_plan"], ensure_ascii=False),
        feedback_id=task.id,
        content_summary=content[:500],
        iteration_of=task.id,
        published="false",
        kb_doc_id=doc_id or None,
        collection_name=collection,
    )
    db.add(entry)
    payload["doc_id"] = doc_id
    payload["experience_id"] = entry.id
    payload["collection"] = collection
    task.payload_json = _dump(payload)
    await db.flush()
    return {"status": "applied", "doc_id": doc_id, "experience_id": entry.id, "count": count}


async def _apply_scenario(db: AsyncSession, task: LearningTask) -> dict[str, Any]:
    payload = _loads(task.payload_json)
    scenario_id = str(payload.get("scenario_id") or task.target_id or "")
    line = str(payload.get("line") or "").strip()
    row = await db.get(ScenarioProfile, scenario_id)
    if row is None or not line:
        return {"status": "failed", "reason": "missing_scenario"}
    before = row.preset_instructions or ""
    version_before = row.version or "1.0.0"
    status_before = row.status
    if line in before:
        return {
            "status": "duplicate",
            "preset_before": before,
            "version_before": version_before,
            "status_before": status_before,
        }
    row.preset_instructions = before.rstrip() + f"\n{line}\n"
    row.version = bump_version(version_before)
    row.updated_at = datetime.now().isoformat()
    await db.flush()
    return {
        "status": "applied",
        "preset_before": before,
        "version_before": version_before,
        "status_before": status_before,
        "line": line,
    }


async def _rollback(db: AsyncSession, parent: LearningTask, loader: SkillLoader, now: datetime) -> None:
    payload = _loads(parent.payload_json)
    baseline = _loads(parent.baseline_json)
    if parent.kind in ("patch_skill", "create_skill"):
        name = str(payload.get("skill_name") or parent.target_id or "")
        lifecycle = SkillLifecycleService(db, loader)
        if payload.get("created") or parent.kind == "create_skill":
            try:
                await lifecycle.uninstall(name, keep_versions=False)
            except SkillNotFoundError:
                logger.info("learning_plan rollback skill missing task_id=%s target_id=%s", parent.id, name)
            root = loader.skills_root / name
            if name.startswith("learned_") and root.exists():
                shutil.rmtree(root, ignore_errors=True)
        else:
            version = str(baseline.get("version_before") or "")
            if version:
                await lifecycle.restore_version(name, version)
    elif parent.kind == "fill_kb":
        doc_id = str(payload.get("doc_id") or "")
        collection = str(payload.get("collection") or TPD_EXPERIENCE_COLLECTION)
        if doc_id:
            try:
                await delete_kb_entry(collection=collection, doc_id=doc_id, project_id=str(payload.get("project_id") or "__all__"))
            except Exception:
                logger.exception("learning_plan kb rollback failed task_id=%s doc_id=%s", parent.id, doc_id)
        experience_id = str(payload.get("experience_id") or "")
        if experience_id:
            entry = await db.get(ExperienceEntry, experience_id)
            if entry is not None:
                await db.delete(entry)
    elif parent.kind == "tune_scenario":
        row = await db.get(ScenarioProfile, parent.target_id or "")
        if row is not None:
            row.preset_instructions = str(baseline.get("preset_before") or "")
            if baseline.get("version_before"):
                row.version = str(baseline["version_before"])
            row.updated_at = now.isoformat()
    _touch(parent, "rolled_back")
    audit = LearningTask(
        id=str(uuid.uuid4()),
        dedupe_key=f"rollback:{parent.id}",
        kind="rollback",
        status="done",
        target_kind=parent.target_kind,
        target_id=parent.target_id,
        summary=f"已回滚：{parent.summary or parent.target_id}",
        signal_type=parent.signal_type,
        rule_id=parent.rule_id,
        parent_id=parent.id,
        night_key=parent.night_key,
        created_at=now.isoformat(),
        updated_at=now.isoformat(),
    )
    db.add(audit)
    logger.info(
        "learning_plan rolled back task_id=%s dedupe_key=%s kind=%s target_id=%s",
        parent.id,
        parent.dedupe_key,
        parent.kind,
        parent.target_id,
    )


async def _execute(db: AsyncSession, task: LearningTask, loader: SkillLoader, now: datetime) -> None:
    if task.kind == "verify":
        parent = await db.get(LearningTask, task.parent_id or "")
        if parent is None or parent.status != "verifying":
            _touch(task, "done")
            return
        acceptance = _loads(parent.acceptance_json)
        baseline = _loads(parent.baseline_json)
        before = float(baseline.get("value") or 0)
        after = await _measure(db, acceptance)
        task.payload_json = _dump({"before": before, "after": after, "parent_id": parent.id})
        if _improved(acceptance, before, after):
            _touch(parent, "done")
            _touch(task, "done")
            logger.info(
                "learning_plan verify passed task_id=%s parent_id=%s kind=%s before=%s after=%s",
                task.id,
                parent.id,
                parent.kind,
                before,
                after,
            )
            return
        await _rollback(db, parent, loader, now)
        _touch(task, "done")
        logger.info(
            "learning_plan verify failed task_id=%s parent_id=%s kind=%s before=%s after=%s",
            task.id,
            parent.id,
            parent.kind,
            before,
            after,
        )
        return

    acceptance = await _acceptance_for(task, db)
    before = await _measure(db, acceptance)
    if task.kind in ("patch_skill", "create_skill"):
        outcome = await _apply_skill(db, task, loader)
    elif task.kind == "fill_kb":
        outcome = await _apply_kb(db, task)
    elif task.kind == "tune_scenario":
        outcome = await _apply_scenario(db, task)
    else:
        _touch(task, "rolled_back")
        return

    status = outcome.get("status")
    if status == "failed":
        result = await _mark_attempts(task, str(outcome.get("reason") or "failed"))
        logger.info(
            "learning_plan apply failed task_id=%s dedupe_key=%s kind=%s result=%s",
            task.id,
            task.dedupe_key,
            task.kind,
            result,
        )
        return
    if status == "duplicate":
        _touch(task, "done")
        logger.info(
            "learning_plan apply duplicate task_id=%s dedupe_key=%s kind=%s",
            task.id,
            task.dedupe_key,
            task.kind,
        )
        return

    payload = _loads(task.payload_json)
    if outcome.get("created"):
        payload["created"] = True
        task.payload_json = _dump(payload)
    baseline = {"value": before, "metric": acceptance.get("metric")}
    if "version_before" in outcome:
        baseline["version_before"] = outcome.get("version_before")
    if "preset_before" in outcome:
        baseline["preset_before"] = outcome.get("preset_before")
        baseline["version_before"] = outcome.get("version_before")
    if task.kind == "fill_kb":
        baseline["value"] = float(outcome.get("count") or payload.get("count") or before)
    task.night_key = _night_key(now)
    await _schedule_verify(db, task, now, baseline, acceptance)
    logger.info(
        "learning_plan applied task_id=%s dedupe_key=%s kind=%s target_id=%s",
        task.id,
        task.dedupe_key,
        task.kind,
        task.target_id,
    )


async def claim_one(
    db: AsyncSession,
    *,
    now: datetime | None = None,
    loader: SkillLoader | None = None,
    respect_quiet: bool = True,
) -> dict[str, Any]:
    """夜窗内领取一条到期任务。窗外直接返回，不写资产。"""
    moment = now or datetime.now()
    if not in_night_window(moment):
        logger.info("learning_plan claim skipped reason=outside_window")
        return {"status": "skipped", "reason": "outside_window"}
    if respect_quiet:
        from backend.services.system_quiet import system_is_quiet

        quiet, reason = await system_is_quiet(db)
        if not quiet:
            logger.info("learning_plan claim deferred reason=%s", reason)
            return {"status": "deferred", "reason": reason}
    night_key = _night_key(moment)
    stale = (
        await db.execute(select(LearningTask).where(LearningTask.status == "running"))
    ).scalars().all()
    for row in stale:
        _touch(row, "confirmed")
        logger.info(
            "learning_plan requeue running task_id=%s dedupe_key=%s kind=%s",
            row.id,
            row.dedupe_key,
            row.kind,
        )
    if stale:
        await db.commit()
    task = await _pick_task(db, moment, night_key)
    if task is None:
        logger.info("learning_plan claim idle night_key=%s", night_key)
        return {"status": "idle", "night_key": night_key}
    skill_loader = loader or SkillLoader()
    if task.kind in APPLY_KINDS:
        task.night_key = night_key
    _touch(task, "running")
    await db.commit()
    try:
        await _execute(db, task, skill_loader, moment)
        await db.commit()
    except Exception:
        logger.exception(
            "learning_plan claim failed task_id=%s dedupe_key=%s kind=%s",
            task.id,
            task.dedupe_key,
            task.kind,
        )
        await db.rollback()
        failed = await db.get(LearningTask, task.id)
        if failed is not None and failed.status == "running":
            await _mark_attempts(failed, "exception")
            await db.commit()
        return {"status": "failed", "task_id": task.id, "kind": task.kind}
    logger.info(
        "learning_plan claimed task_id=%s dedupe_key=%s kind=%s status=%s",
        task.id,
        task.dedupe_key,
        task.kind,
        task.status,
    )
    return {"status": task.status, "task_id": task.id, "kind": task.kind, "night_key": night_key}
