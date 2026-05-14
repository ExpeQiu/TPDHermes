"""
模板装载与输出校验（章节标题）。
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.template import Template

logger = logging.getLogger("tpdx.hermes")


def _parse_schema_json(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


async def get_template_by_id(db: AsyncSession, template_id: str) -> Template | None:
    res = await db.execute(select(Template).where(Template.id == template_id))
    return res.scalar_one_or_none()


def extract_required_sections(template: Template | None) -> list[str]:
    if not template:
        return []
    schema = _parse_schema_json(template.schema_json)
    req = schema.get("required_sections")
    if isinstance(req, list):
        return [str(x) for x in req]
    return []


def validate_markdown_sections(
    content: str,
    required_sections: list[str],
    must_have_headings: bool = True,
) -> dict[str, Any]:
    """
    校验 Markdown 是否包含所需章节标题（支持 # / ## 形式，标题文本包含即可）。
    """
    if not required_sections:
        return {"ok": True, "missing": [], "warnings": []}

    headings: set[str] = set()
    for line in content.splitlines():
        m = re.match(r"^\s{0,3}(#{1,6})\s+(.+?)\s*$", line)
        if m:
            headings.add(m.group(2).strip().lower())

    missing: list[str] = []
    for sec in required_sections:
        key = sec.strip().lower()
        if not any(key in h or h in key for h in headings):
            missing.append(sec)

    ok = len(missing) == 0 if must_have_headings else True
    if not must_have_headings:
        missing = []

    result = {"ok": ok, "missing": missing, "warnings": []}
    if missing:
        result["warnings"].append(f"缺少章节标题: {', '.join(missing)}")
    logger.info("template_validate ok=%s missing=%s", ok, missing)
    return result
