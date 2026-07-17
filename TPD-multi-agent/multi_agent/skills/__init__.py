"""可被 Agent 调用的 Skills 目录（工具 / MCP / shell）。"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

import yaml

from multi_agent.utils.errors import MultiAgentError

logger = logging.getLogger("multi_agent.skills")

SKILLS_ROOT = Path(__file__).resolve().parent
SKILL_ID_RE = re.compile(r"^[a-z][a-z0-9_]*$")
VALID_KINDS = frozenset({"tool", "prompt", "mcp"})
VALID_RUNTIME = frozenset({"builtin", "http", "mcp", "shell"})
VALID_RISK = frozenset({"none", "network", "filesystem", "shell"})


def validate_skill_id(skill_id: str) -> str:
    sid = (skill_id or "").strip().lower()
    if not SKILL_ID_RE.match(sid):
        raise MultiAgentError("skill id 须为 snake_case，如 web_search、kb_search")
    return sid


def _skill_path(skill_id: str) -> Path:
    return SKILLS_ROOT / f"{skill_id}.yml"


def list_skill_ids() -> list[str]:
    return sorted(
        p.stem
        for p in SKILLS_ROOT.glob("*.yml")
        if p.is_file() and not p.name.startswith("._") and SKILL_ID_RE.match(p.stem)
    )


def list_skills_meta() -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for sid in list_skill_ids():
        try:
            data = load_skill(sid)
            items.append(
                {
                    "id": data["id"],
                    "name": data.get("name") or sid,
                    "description": data.get("description") or "",
                    "kind": data.get("kind") or "tool",
                    "runtime": data.get("runtime") or "builtin",
                    "enabled": bool(data.get("enabled", True)),
                    "risk": data.get("risk") or "none",
                }
            )
        except MultiAgentError as exc:
            logger.warning("跳过无效 skill %s: %s", sid, exc)
    return items


def load_skill(skill_id: str) -> dict[str, Any]:
    sid = validate_skill_id(skill_id)
    path = _skill_path(sid)
    if not path.is_file():
        raise MultiAgentError(f"未知 skill: {sid}")
    with path.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    if not isinstance(data, dict):
        raise MultiAgentError(f"无效 skill 文件: {path}")
    return normalize_skill({**data, "id": data.get("id") or sid})


def normalize_skill(payload: dict[str, Any]) -> dict[str, Any]:
    sid = validate_skill_id(str(payload.get("id") or ""))
    name = str(payload.get("name") or "").strip()
    if not name:
        raise MultiAgentError("skill 需要 name")
    kind = str(payload.get("kind") or "tool").strip().lower()
    runtime = str(payload.get("runtime") or "builtin").strip().lower()
    risk = str(payload.get("risk") or "none").strip().lower()
    if kind not in VALID_KINDS:
        raise MultiAgentError(f"无效 kind: {kind}")
    if runtime not in VALID_RUNTIME:
        raise MultiAgentError(f"无效 runtime: {runtime}")
    if risk not in VALID_RISK:
        raise MultiAgentError(f"无效 risk: {risk}")
    return {
        "id": sid,
        "name": name,
        "description": str(payload.get("description") or "").strip(),
        "enabled": bool(payload.get("enabled", True)),
        "kind": kind,
        "runtime": runtime,
        "entry": str(payload.get("entry") or "").strip(),
        "when": str(payload.get("when") or "").strip(),
        "risk": risk,
        "agent_safe": bool(payload.get("agent_safe", True)),
        "import_source": str(payload.get("import_source") or "").strip(),
    }


def save_skill(payload: dict[str, Any], *, create: bool = False) -> dict[str, Any]:
    data = normalize_skill(payload)
    sid = data["id"]
    path = _skill_path(sid)
    exists = path.is_file()
    if create and exists:
        raise MultiAgentError(f"skill 已存在: {sid}")
    if not create and not exists:
        raise MultiAgentError(f"未知 skill: {sid}")
    dump = {k: v for k, v in data.items() if v or k in {"id", "name", "enabled", "agent_safe"}}
    text = yaml.safe_dump(dump, allow_unicode=True, sort_keys=False, default_flow_style=False)
    path.write_text(text, encoding="utf-8")
    logger.info("已保存 skill id=%s path=%s create=%s", sid, path, create and not exists)
    return load_skill(sid)


def delete_skill(skill_id: str) -> None:
    sid = validate_skill_id(skill_id)
    path = _skill_path(sid)
    if not path.is_file():
        raise MultiAgentError(f"未知 skill: {sid}")
    path.unlink()
    logger.info("已删除 skill id=%s", sid)


def import_skill_markdown(text: str, *, source: str = "") -> dict[str, Any]:
    """从 Agent Skills 风格 SKILL.md（含 YAML frontmatter）导入。"""
    raw = (text or "").strip()
    if not raw.startswith("---"):
        raise MultiAgentError("SKILL.md 需以 YAML frontmatter（---）开头")
    end = raw.find("\n---", 3)
    if end < 0:
        raise MultiAgentError("SKILL.md frontmatter 未闭合")
    fm = yaml.safe_load(raw[3:end]) or {}
    if not isinstance(fm, dict):
        raise MultiAgentError("frontmatter 不是对象")
    body = raw[end + 4 :].strip()
    sid = str(fm.get("name") or fm.get("id") or "").strip().lower().replace("-", "_")
    if not sid:
        raise MultiAgentError("frontmatter 需要 name 或 id")
    desc = str(fm.get("description") or "").strip()
    if not desc and body:
        desc = body.splitlines()[0].lstrip("# ").strip()[:200]
    payload = {
        "id": sid,
        "name": str(fm.get("title") or fm.get("name") or sid).strip(),
        "description": desc,
        "enabled": True,
        "kind": "prompt",
        "runtime": "builtin",
        "when": str(fm.get("description") or "")[:120],
        "risk": "none",
        "agent_safe": True,
        "import_source": source or "skill.md",
        "entry": "",
    }
    return save_skill(payload, create=not _skill_path(validate_skill_id(sid)).is_file())
