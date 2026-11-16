"""共创角色上的工坊技能名单。与 multi_agent.roles 的 skills 字段对齐。"""

from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger("tpdx.hermes.co_create_room")

_SKILL_ID_RE = re.compile(r"^[a-z][a-z0-9_]*$")
_LEGACY_SKILL_SENTENCE = re.compile(r"对齐\s*skills\s*[:：]\s*([^。\n]*)[。]?\s*")


def _names_from_clause(clause: str) -> list[str]:
    names: list[str] = []
    for part in re.split(r"[\s,，、]+", clause):
        name = part.strip()
        if _SKILL_ID_RE.match(name) and name not in names:
            names.append(name)
    return names


def strip_legacy_skill_sentence(system: str) -> str:
    cleaned = _LEGACY_SKILL_SENTENCE.sub("", str(system or ""))
    return re.sub(r"[ \t]{2,}", " ", cleaned).strip()


def role_workshop_skills(role: dict[str, Any]) -> list[str]:
    """优先用 skills 字段。旧人设只在句子里写过技能时，从 system 补齐。"""
    raw = role.get("skills")
    names: list[str] = []
    if isinstance(raw, str):
        names = _names_from_clause(raw)
    elif isinstance(raw, list):
        for item in raw:
            name = str(item or "").strip()
            if _SKILL_ID_RE.match(name) and name not in names:
                names.append(name)
    if names:
        return names
    found: list[str] = []
    for match in _LEGACY_SKILL_SENTENCE.finditer(str(role.get("system") or "")):
        for name in _names_from_clause(match.group(1)):
            if name not in found:
                found.append(name)
    return found


def describe_workshop_skills(names: list[str]) -> list[str]:
    """用技能 discovery 的 description / when 写成选用说明。缺文件时只留 id。"""
    if not names:
        return []
    try:
        from backend.services.skill_loader import get_loader
        from backend.services.skill_package import resolve_skill_discovery

        loader = get_loader()
    except Exception as exc:  # noqa: BLE001
        logger.warning("[co-create-room] skill catalog unavailable err=%s", exc.__class__.__name__)
        return list(names)
    hints: list[str] = []
    for name in names:
        try:
            disc = resolve_skill_discovery(loader.skills_root / name, name)
        except Exception as exc:  # noqa: BLE001
            logger.warning("[co-create-room] skill discovery failed skill=%s err=%s", name, exc.__class__.__name__)
            hints.append(name)
            continue
        label = str(disc.get("display_name") or name).strip()
        selection = str(disc.get("selection") or disc.get("description") or disc.get("when") or "").strip()
        if selection:
            hints.append(f"{name}（{label}：{selection}）")
        else:
            hints.append(name)
    return hints


def workshop_skill_contract(role: dict[str, Any], ctx: dict[str, Any]) -> str:
    """告诉 Hermes 按工坊工具执行，不要走 skill_view 或读技能文件。"""
    names = role_workshop_skills(role)
    if not names:
        return ""
    hints = describe_workshop_skills(names)
    run_id = str(ctx.get("run_id") or "").strip()
    project_id = str(ctx.get("project_id") or "").strip()
    token = str(ctx.get("execution_token") or "").strip()
    lines = [
        "本角色只能使用下列工坊技能。按用户意图选一个最匹配的，不要因为名称相近就跳过更匹配的技能。",
        "技能：" + "；".join(hints) + "。",
        "执行时调用 workshop_generate；有项目知识库时优先 workshop_generate_from_kb。",
        "不要调用 skill_view，不要读取 /opt/project-skills、/app/skills 或 SKILL.md，不要把技能说明写进回复。",
        "skill_name 必须是：" + "、".join(names) + "。",
    ]
    if run_id:
        lines.append(f"必须原样传入 TPCharness_run_id={run_id}。")
    if project_id:
        lines.append(f"必须原样传入 project_id={project_id}。")
    if token:
        lines.append(f"必须原样传入 execution_token={token}。不要在面向用户的回复里复述该凭证。")
    if ctx.get("allow_write"):
        lines.append("回复只用一两句说明选用了哪个技能。平台把工具返回的正文写入项目文件。")
    else:
        lines.append("用工具返回的正文回答，不要粘贴技能文件。")
    logger.info(
        "[co-create-room] skill contract role_id=%s skills=%s run_id=%s allow_write=%s",
        role.get("id") or "",
        ",".join(names),
        run_id,
        bool(ctx.get("allow_write")),
    )
    return "\n" + "\n".join(lines)
