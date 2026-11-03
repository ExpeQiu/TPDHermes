"""
从对话与反馈里抽出可复用纠正，直接改已有技能或新建技能。

写入前保证当前版本有快照；写入后走 SkillLifecycleService 递增版本。
同一条规则以 evolved 标记去重，调度重复跑不会叠版本。
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import desc, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.chat_session import ChatMessageRecord, ChatSessionRecord
from backend.models.feedback_event import FeedbackEvent
from backend.models.project_room import ProjectRoomMessage
from backend.models.learning_signal import LearningSignal
from backend.models.skill import Skill
from backend.services.skill_lifecycle import SkillLifecycleService
from backend.services.skill_loader import SkillLoader
from backend.services.skill_metrics_service import _resolve_skill_for_feedback
from backend.services.skill_package import (
    STANDARD_SKILL_MD_TEMPLATE,
    ensure_python_stub,
)

logger = logging.getLogger("tpdx.hermes.skill_evolution")

MIN_SUPPORT = 2
MAX_ACTIONS = 8
MAX_RULE_CHARS = 180
_CORRECTION = re.compile(r"不要|别再|改成|太长|太啰嗦|下次|记住|格式|不应该|写短|精简|少写")
_NOISE = re.compile(
    r"command not found|ModuleNotFound|No such file|未安装|没有那个文件|Traceback",
    re.IGNORECASE,
)
_GENERIC_PREFIXES = ("建议更新", "建议复核", "建议检查")
_SKILL_KEYS = ("skill", "skill_name")
_SCENARIO_KEYS = ("scenario_id", "scenario")


@dataclass
class Episode:
    rule: str
    skill_name: str | None
    evidence_id: str
    weight: int = 1


@dataclass
class EvolutionAction:
    action: str
    skill_name: str
    rule: str
    rule_id: str
    support: int
    evidence_ids: list[str] = field(default_factory=list)


def evolution_enabled() -> bool:
    return os.getenv("SKILL_EVOLUTION_ENABLED", "true").lower() in ("1", "true", "yes")


def rule_id_for(rule: str) -> str:
    return hashlib.sha256(rule.encode("utf-8")).hexdigest()[:12]


def normalize_rule(text: str | None) -> str | None:
    raw = re.sub(r"\s+", " ", (text or "").strip())
    raw = raw.strip("\"'“”‘’")
    raw = raw.replace("<!--", "").replace("-->", "")
    if not raw:
        return None
    raw = re.split(r"[。！？\n]", raw, maxsplit=1)[0].strip()
    if len(raw) > MAX_RULE_CHARS:
        raw = raw[:MAX_RULE_CHARS].rstrip()
    if len(raw) < 8 or _NOISE.search(raw):
        return None
    if raw.startswith(_GENERIC_PREFIXES):
        return None
    return raw


def is_correction_text(text: str | None) -> bool:
    rule = normalize_rule(text)
    return bool(rule and _CORRECTION.search(rule))


def format_bullet(rule: str, rule_id: str, support: int) -> str:
    return f"- 遵循：{rule}（依据 {support} 次） <!-- evolved:{rule_id} -->"


def evolved_marker(rule_id: str) -> str:
    return f"<!-- evolved:{rule_id} -->"


def append_evolved_rule(text: str, rule: str, rule_id: str, support: int) -> str:
    marker = evolved_marker(rule_id)
    if marker in text:
        return text
    bullet = format_bullet(rule, rule_id, support)
    header = "## 自进化"
    if header in text:
        lines = text.splitlines()
        out: list[str] = []
        inserted = False
        for line in lines:
            out.append(line)
            if not inserted and line.strip() == header:
                out.append("")
                out.append(bullet)
                inserted = True
        if not inserted:
            out.extend(["", header, "", bullet])
        body = "\n".join(out)
        return body if text.endswith("\n") else body + "\n"
    return text.rstrip() + f"\n\n{header}\n\n{bullet}\n"


def match_skill(candidate: str | None, known: set[str]) -> str | None:
    name = (candidate or "").strip()
    if not name:
        return None
    underscored = name.replace("-", "_")
    suffixed = underscored if underscored.endswith("_skill") else f"{underscored}_skill"
    for item in (name, underscored, suffixed):
        if item in known:
            return item
    return None


def plan_actions(episodes: list[Episode], known_skills: set[str]) -> list[EvolutionAction]:
    buckets: dict[tuple[str, str], list[Episode]] = defaultdict(list)
    for episode in episodes:
        skill = episode.skill_name if episode.skill_name in known_skills else ""
        buckets[(skill, rule_id_for(episode.rule))].append(episode)

    actions: list[EvolutionAction] = []
    for (skill, rule_id), group in buckets.items():
        support = sum(max(1, episode.weight) for episode in group)
        if support < MIN_SUPPORT:
            continue
        rule = group[0].rule
        evidence_ids: list[str] = []
        seen: set[str] = set()
        for episode in group:
            if episode.evidence_id in seen:
                continue
            seen.add(episode.evidence_id)
            evidence_ids.append(episode.evidence_id)
        if skill:
            action = "patch"
            skill_name = skill
        else:
            action = "create"
            skill_name = f"learned_{rule_id}"
        actions.append(
            EvolutionAction(
                action=action,
                skill_name=skill_name,
                rule=rule,
                rule_id=rule_id,
                support=support,
                evidence_ids=evidence_ids,
            )
        )
    actions.sort(key=lambda item: (-item.support, item.skill_name, item.rule_id))
    return actions


def _loads(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _first_str(data: dict[str, Any], keys: tuple[str, ...]) -> str | None:
    for key in keys:
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, list):
            for item in value:
                if isinstance(item, str) and item.strip():
                    return item.strip()
    return None


def render_learned_skill_md(name: str, rule: str, rule_id: str, support: int) -> str:
    bullet = format_bullet(rule, rule_id, support)
    return (
        f"---\nname: {name}\ndescription: 从对话纠正沉淀的做法。\n---\n\n"
        "# 对话沉淀\n\n"
        "## 何时使用\n\n"
        "- 再次遇到与这条纠正相同的一类任务时。\n\n"
        "## 自进化\n\n"
        f"{bullet}\n"
    )


def _ensure_presnapshot(lifecycle: SkillLifecycleService, name: str, version: str) -> None:
    current = lifecycle.version_service._version_dir(name, version or "1.0.0")
    if current.exists():
        return
    lifecycle.version_service.snapshot(name, version or "1.0.0", "自进化前快照")
    logger.info("skill_evolution presnapshot skill=%s version=%s", name, version or "1.0.0")


async def _known_skills(db: AsyncSession) -> set[str]:
    rows = await db.execute(select(Skill.name))
    return {str(name) for name in rows.scalars().all() if name}


async def _feedback_episodes(
    db: AsyncSession,
    *,
    since: str,
    known: set[str],
) -> list[Episode]:
    rows = (
        await db.execute(
            select(FeedbackEvent)
            .where(FeedbackEvent.created_at >= since)
            .order_by(desc(FeedbackEvent.created_at))
            .limit(200)
        )
    ).scalars().all()
    cache: dict[str, str | None] = {}
    episodes: list[Episode] = []
    for row in rows:
        if row.adoption_level not in {"reject", "partial"} and row.reaction_type != "rewrite":
            continue
        rule = normalize_rule(row.reason_text or row.memory_line)
        if not rule:
            continue
        resolved = None
        if (row.run_id or "").strip() or (row.output_id or "").strip():
            resolved = await _resolve_skill_for_feedback(
                db,
                run_id=row.run_id,
                output_id=row.output_id,
                run_skill_cache=cache,
            )
        skill = match_skill(resolved, known) or match_skill(row.scenario_id, known)
        episodes.append(Episode(rule=rule, skill_name=skill, evidence_id=f"feedback:{row.id}"))
    return episodes


async def _chat_episodes(
    db: AsyncSession,
    *,
    since: str,
    known: set[str],
) -> list[Episode]:
    messages = (
        await db.execute(
            select(ChatMessageRecord)
            .where(
                ChatMessageRecord.role == "user",
                ChatMessageRecord.created_at >= since,
            )
            .order_by(desc(ChatMessageRecord.created_at))
            .limit(400)
        )
    ).scalars().all()
    session_ids = {row.session_id for row in messages if row.session_id}
    contexts: dict[str, dict[str, Any]] = {}
    if session_ids:
        sessions = (
            await db.execute(
                select(ChatSessionRecord).where(ChatSessionRecord.id.in_(session_ids))
            )
        ).scalars().all()
        contexts = {row.id: _loads(row.context_json) for row in sessions}

    episodes: list[Episode] = []
    for row in messages:
        content = (row.content or "")[:500]
        if not is_correction_text(content):
            continue
        rule = normalize_rule(content)
        if not rule:
            continue
        meta = _loads(row.metadata_json)
        ctx = contexts.get(row.session_id or "", {})
        candidate = (
            _first_str(meta, _SKILL_KEYS)
            or _first_str(ctx, _SKILL_KEYS)
            or _first_str(meta, _SCENARIO_KEYS)
            or _first_str(ctx, _SCENARIO_KEYS)
        )
        episodes.append(
            Episode(
                rule=rule,
                skill_name=match_skill(candidate, known),
                evidence_id=f"chat:{row.id}",
            )
        )
    return episodes


async def _room_episodes(
    db: AsyncSession,
    *,
    since: str,
    known: set[str],
) -> list[Episode]:
    """共创群里的人话纠正。表不存在时跳过，不打断事务。"""
    try:
        async with db.begin_nested():
            messages = (
                await db.execute(
                    select(ProjectRoomMessage)
                    .where(
                        ProjectRoomMessage.author_type == "human",
                        ProjectRoomMessage.created_at >= since,
                    )
                    .order_by(desc(ProjectRoomMessage.created_at))
                    .limit(200)
                )
            ).scalars().all()
    except SQLAlchemyError:
        logger.info("skill_evolution room messages unavailable")
        return []
    episodes: list[Episode] = []
    for row in messages:
        content = (row.content or "")[:500]
        if not is_correction_text(content):
            continue
        rule = normalize_rule(content)
        if not rule:
            continue
        episodes.append(
            Episode(
                rule=rule,
                skill_name=match_skill(row.author_id, known),
                evidence_id=f"room:{row.id}",
            )
        )
    return episodes


async def _signal_episodes(db: AsyncSession, known: set[str]) -> list[Episode]:
    rows = (
        await db.execute(
            select(LearningSignal)
            .where(LearningSignal.status == "open")
            .order_by(desc(LearningSignal.last_seen_at))
            .limit(50)
        )
    ).scalars().all()
    episodes: list[Episode] = []
    for row in rows:
        if row.signal_type not in {"repeated_correction", "low_adoption_scenario"}:
            continue
        payload = _loads(row.payload_json)
        samples = payload.get("reason_samples") if isinstance(payload.get("reason_samples"), list) else []
        sample = samples[0] if samples else ""
        rule = normalize_rule(str(sample or ""))
        if not rule:
            continue
        skill = match_skill(row.entity_id, known) if row.entity_kind == "scenario" else None
        episodes.append(
            Episode(
                rule=rule,
                skill_name=skill,
                evidence_id=f"signal:{row.id}",
                weight=max(int(row.count or 1), 1),
            )
        )
    return episodes


async def _patch_skill(
    lifecycle: SkillLifecycleService,
    action: EvolutionAction,
) -> dict[str, Any]:
    root = lifecycle.loader.skills_root / action.skill_name
    if not root.is_dir():
        logger.info(
            "skill_evolution skip skill=%s rule_id=%s reason=missing_dir",
            action.skill_name,
            action.rule_id,
        )
        return {"status": "skipped", "reason": "missing_dir", **_action_fields(action)}
    row = await lifecycle._get_db_skill(action.skill_name)
    if row is None:
        logger.info(
            "skill_evolution skip skill=%s rule_id=%s reason=missing_db",
            action.skill_name,
            action.rule_id,
        )
        return {"status": "skipped", "reason": "missing_db", **_action_fields(action)}

    version = row.version or "1.0.0"
    _ensure_presnapshot(lifecycle, action.skill_name, version)
    skill_md = root / "SKILL.md"
    current = skill_md.read_text(encoding="utf-8") if skill_md.is_file() else ""
    if not current.strip():
        current = STANDARD_SKILL_MD_TEMPLATE.format(
            name=action.skill_name,
            description="自进化补记。",
            title=action.skill_name,
        )
    if evolved_marker(action.rule_id) in current:
        logger.info(
            "skill_evolution skip skill=%s rule_id=%s reason=duplicate support=%s",
            action.skill_name,
            action.rule_id,
            action.support,
        )
        return {"status": "skipped", "reason": "duplicate", "version": version, **_action_fields(action)}

    updated = append_evolved_rule(current, action.rule, action.rule_id, action.support)
    skill_md.write_text(updated, encoding="utf-8")
    if not (root / "__init__.py").is_file():
        ensure_python_stub(root, action.skill_name)
    saved = await lifecycle.update_skill(
        action.skill_name,
        changelog=f"自进化 {action.rule_id} support={action.support}",
    )
    logger.info(
        "skill_evolution patched skill=%s rule_id=%s support=%s version=%s evidence=%s",
        action.skill_name,
        action.rule_id,
        action.support,
        saved.get("version"),
        ",".join(action.evidence_ids[:8]),
    )
    return {"status": "patched", "version": saved.get("version"), **_action_fields(action)}


async def _create_skill(
    lifecycle: SkillLifecycleService,
    action: EvolutionAction,
) -> dict[str, Any]:
    existing = await lifecycle.get_skill(action.skill_name)
    if existing:
        return await _patch_skill(lifecycle, action)

    root = lifecycle.loader.skills_root / action.skill_name
    if root.exists():
        logger.info(
            "skill_evolution skip skill=%s rule_id=%s reason=unregistered_dir",
            action.skill_name,
            action.rule_id,
        )
        return {"status": "skipped", "reason": "unregistered_dir", **_action_fields(action)}
    root.mkdir(parents=True)
    try:
        (root / "SKILL.md").write_text(
            render_learned_skill_md(action.skill_name, action.rule, action.rule_id, action.support),
            encoding="utf-8",
        )
        (root / "skill.json").write_text(
            json.dumps(
                {
                    "name": action.skill_name,
                    "description": "从对话纠正沉淀的做法。",
                    "version": "1.0.0",
                    "author": "learned",
                    "source": "conversation",
                    "rule_id": action.rule_id,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        ensure_python_stub(root, action.skill_name)
        saved = await lifecycle.install(
            name=action.skill_name,
            description=action.rule[:200],
            config={
                "learned": True,
                "rule_id": action.rule_id,
                "support": action.support,
            },
            source="learned",
        )
    except Exception:
        logger.exception(
            "skill_evolution create failed skill=%s rule_id=%s",
            action.skill_name,
            action.rule_id,
        )
        saved_row = await lifecycle.get_skill(action.skill_name)
        if saved_row is None and root.exists():
            shutil.rmtree(root, ignore_errors=True)
        lifecycle.loader._cache.pop(action.skill_name, None)
        return {"status": "skipped", "reason": "error", **_action_fields(action)}
    logger.info(
        "skill_evolution created skill=%s rule_id=%s support=%s version=%s evidence=%s",
        action.skill_name,
        action.rule_id,
        action.support,
        saved.get("version"),
        ",".join(action.evidence_ids[:8]),
    )
    return {"status": "created", "version": saved.get("version"), **_action_fields(action)}


def _action_fields(action: EvolutionAction) -> dict[str, Any]:
    return {
        "action": action.action,
        "skill": action.skill_name,
        "rule_id": action.rule_id,
        "support": action.support,
        "evidence_ids": action.evidence_ids[:8],
    }


async def apply_actions(
    db: AsyncSession,
    actions: list[EvolutionAction],
    loader: SkillLoader,
) -> dict[str, list[dict[str, Any]]]:
    lifecycle = SkillLifecycleService(db, loader)
    patched: list[dict[str, Any]] = []
    created: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for action in actions:
        try:
            if action.action == "create":
                result = await _create_skill(lifecycle, action)
            else:
                result = await _patch_skill(lifecycle, action)
        except Exception:
            logger.exception(
                "skill_evolution apply failed skill=%s rule_id=%s action=%s",
                action.skill_name,
                action.rule_id,
                action.action,
            )
            skipped.append({"status": "skipped", "reason": "error", **_action_fields(action)})
            continue
        status = result.get("status")
        if status == "patched":
            patched.append(result)
        elif status == "created":
            created.append(result)
        else:
            skipped.append(result)
    return {"patched": patched, "created": created, "skipped": skipped}


async def evolve_recent(
    db: AsyncSession,
    *,
    days: int = 14,
    loader: SkillLoader | None = None,
) -> dict[str, Any]:
    """扫描近期反馈、用户纠正句和学习信号，并落成带版本的技能变更。"""
    if not evolution_enabled():
        logger.info("skill_evolution disabled")
        return {
            "enabled": False,
            "days": days,
            "episodes": 0,
            "actions": 0,
            "patched": [],
            "created": [],
            "skipped": [],
        }

    window = max(1, min(int(days), 60))
    since = (datetime.now() - timedelta(days=window)).isoformat()
    skill_loader = loader or SkillLoader()
    known = await _known_skills(db)
    feedback = await _feedback_episodes(db, since=since, known=known)
    chat = await _chat_episodes(db, since=since, known=known)
    rooms = await _room_episodes(db, since=since, known=known)
    signals = await _signal_episodes(db, known)
    episodes = feedback + chat + rooms + signals
    planned = plan_actions(episodes, known)
    actions = planned[:MAX_ACTIONS]
    if len(planned) > len(actions):
        logger.info(
            "skill_evolution truncated planned=%s kept=%s",
            len(planned),
            len(actions),
        )
    logger.info(
        "skill_evolution mine days=%s feedback=%s chat=%s rooms=%s signals=%s episodes=%s actions=%s",
        window,
        len(feedback),
        len(chat),
        len(rooms),
        len(signals),
        len(episodes),
        len(actions),
    )
    applied = await apply_actions(db, actions, skill_loader)
    return {
        "enabled": True,
        "days": window,
        "episodes": len(episodes),
        "actions": len(actions),
        **applied,
    }


_PATCH_LOG = re.compile(r"^自进化 ([0-9a-f]+) support=(\d+)\s*$")
_RULE_LINE = re.compile(r"遵循：(.+?)（依据 (\d+) 次） <!-- evolved:([0-9a-f]+) -->")
_RESTORE_LOG = re.compile(r"^restore from (\S+)\s*$")


def _rules_in_skill_md(path: Path) -> dict[str, dict[str, Any]]:
    if not path.is_file():
        return {}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    found: dict[str, dict[str, Any]] = {}
    for match in _RULE_LINE.finditer(text):
        found[match.group(3)] = {"rule": match.group(1).strip(), "support": int(match.group(2))}
    return found


def _history_time(raw: str | None) -> datetime | None:
    text = (raw or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.replace(tzinfo=None)
    return parsed


async def list_skill_changes(
    db: AsyncSession,
    *,
    days: int = 14,
    limit: int = 50,
    loader: SkillLoader | None = None,
) -> list[dict[str, Any]]:
    """列出近期技能改写、新建和回滚，供学习中心展示。"""
    window = max(1, min(int(days), 60))
    since = datetime.now() - timedelta(days=window)
    skill_loader = loader or SkillLoader()
    rows = (await db.execute(select(Skill))).scalars().all()
    changes: list[dict[str, Any]] = []
    for skill in rows:
        try:
            history = json.loads(skill.version_history or "[]")
        except json.JSONDecodeError:
            history = []
        if not isinstance(history, list):
            continue
        rules = _rules_in_skill_md(skill_loader.skills_root / skill.name / "SKILL.md")
        for entry in history:
            if not isinstance(entry, dict):
                continue
            at_raw = str(entry.get("installed_at") or "")
            at = _history_time(at_raw)
            if at is not None and at < since:
                continue
            changelog = str(entry.get("changelog") or "")
            version = str(entry.get("version") or "")
            base = {
                "skill": skill.name,
                "version": version,
                "at": at_raw,
                "source": skill.source or "",
            }
            patch = _PATCH_LOG.match(changelog)
            if patch:
                rule_id = patch.group(1)
                detail = rules.get(rule_id) or {}
                changes.append(
                    {
                        **base,
                        "action": "patched",
                        "rule_id": rule_id,
                        "support": int(detail.get("support") or patch.group(2)),
                        "rule": str(detail.get("rule") or ""),
                    }
                )
                continue
            restored = _RESTORE_LOG.match(changelog)
            if restored:
                changes.append({**base, "action": "restored", "rule_id": "", "support": 0, "rule": ""})
                continue
            if (skill.source or "") == "learned" and changelog == "Initial install":
                rule_id, detail = next(iter(rules.items()), ("", {}))
                changes.append(
                    {
                        **base,
                        "action": "created",
                        "rule_id": rule_id,
                        "support": int(detail.get("support") or 0) if isinstance(detail, dict) else 0,
                        "rule": str(detail.get("rule") or "") if isinstance(detail, dict) else "",
                    }
                )
    changes.sort(key=lambda item: item.get("at") or "", reverse=True)
    logger.info("skill_evolution changes days=%s count=%s", window, len(changes))
    return changes[: max(1, min(limit, 100))]
