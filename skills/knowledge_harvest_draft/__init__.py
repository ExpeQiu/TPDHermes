"""
knowledge_harvest_draft — 仅生成收割草稿 JSON，不调用 MCP、不写入 KB。
"""

from __future__ import annotations

import re
from typing import Any, Dict

from backend.services.skill_loader import Skill


def _first_line_title(excerpt: str) -> str:
    for line in excerpt.splitlines():
        s = line.strip()
        if s:
            s = re.sub(r"^#+\s*", "", s)
            return s[:200]
    return "知识摘录"


class KnowledgeHarvestDraftSkill(Skill):
    """从对话摘录产出可供用户确认的草稿结构。"""

    @property
    def name(self) -> str:
        return "knowledge_harvest_draft"

    def generate(self, context: Dict[str, Any]) -> Dict[str, Any]:
        excerpt = str(context.get("conversation_excerpt") or "").strip()
        if not excerpt:
            return {
                "success": False,
                "error": "conversation_excerpt 不能为空",
                "draft": None,
            }

        title = str(context.get("title") or "").strip() or _first_line_title(excerpt)
        summary = str(context.get("summary") or "").strip()
        if not summary:
            summary = excerpt[:320] + ("…" if len(excerpt) > 320 else "")

        collection_hint = str(context.get("collection_hint") or "").strip()
        domain = str(context.get("domain_hint") or context.get("domain") or "internal_methodology").strip()

        body = excerpt
        if not body.lstrip().startswith("#"):
            body = f"## 正文\n\n{body}"

        confidence = 0.75 if len(excerpt) > 80 else 0.55

        draft = {
            "title": title,
            "summary": summary,
            "content": body,
            "tags": list(context.get("tags") or []),
            "domain": domain,
            "collection_name": collection_hint or "",
            "source_type": "conversation_harvest",
            "confidence": confidence,
            "project_id": str(context.get("project_id") or "").strip(),
        }

        return {
            "skill": self.name,
            "draft": draft,
            "note": "仅此 JSON 草稿；须经用户确认后再调用 kb_add_entry。",
            "success": True,
        }
