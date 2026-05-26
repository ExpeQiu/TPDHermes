"""
TPD 经验库：将高价值反馈沉淀到 tpd_experience 集合。
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timedelta
from typing import Any, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.experience_entry import ExperienceEntry
from backend.models.feedback_event import FeedbackEvent
from backend.services.kb_write import add_kb_harvest_entry

logger = logging.getLogger("tpdx.hermes.experience")

from backend.services.kb_contract import TPD_EXPERIENCE_COLLECTION

DEFAULT_VALID_DAYS = 180


async def save_experience_from_feedback(
    db: AsyncSession,
    *,
    feedback: FeedbackEvent,
    content: str,
    title: str,
    scenario_tags: Optional[list[str]] = None,
    valid_days: int = DEFAULT_VALID_DAYS,
) -> ExperienceEntry:
    """将采纳/部分采纳的反馈关联内容写入经验库。"""
    tags = scenario_tags or ([feedback.scenario_id] if feedback.scenario_id else ["general"])
    valid_until = (datetime.now() + timedelta(days=valid_days)).strftime("%Y-%m-%d")

    harvest_meta = {
        "source_type": "tpd_experience",
        "feedback_id": feedback.id,
        "run_id": feedback.run_id,
        "output_id": feedback.output_id,
        "adoption_level": feedback.adoption_level,
        "scenario_tags": tags,
        "valid_until": valid_until,
        "iteration_of": feedback.run_id,
    }

    kb_result = await add_kb_harvest_entry(
        collection_name=TPD_EXPERIENCE_COLLECTION,
        project_id=feedback.project_id or "__all__",
        title=title,
        content=content,
        summary=content[:280],
        domain="internal_methodology",
        source="tpd_experience",
        published=False,
        metadata=harvest_meta,
        scenario_id=feedback.scenario_id,
    )

    entry = ExperienceEntry(
        id=str(uuid.uuid4()),
        project_id=feedback.project_id,
        scenario_tags_json=json.dumps(tags, ensure_ascii=False),
        run_id=feedback.run_id,
        output_id=feedback.output_id,
        feedback_id=feedback.id,
        content_summary=content[:500],
        iteration_of=feedback.run_id,
        valid_until=valid_until,
        published="false",
        kb_doc_id=kb_result.get("doc_id"),
        collection_name=TPD_EXPERIENCE_COLLECTION,
    )
    db.add(entry)
    await db.commit()
    await db.refresh(entry)
    logger.info(
        "experience saved id=%s feedback_id=%s doc_id=%s",
        entry.id,
        feedback.id,
        entry.kb_doc_id,
    )
    return entry


async def list_experience_entries(
    db: AsyncSession,
    *,
    limit: int = 50,
) -> list[ExperienceEntry]:
    from sqlalchemy import desc, select

    result = await db.execute(
        select(ExperienceEntry).order_by(desc(ExperienceEntry.created_at)).limit(min(limit, 200))
    )
    return list(result.scalars().all())


def experience_entry_to_dict(row: ExperienceEntry) -> dict[str, Any]:
    tags = []
    if row.scenario_tags_json:
        try:
            tags = json.loads(row.scenario_tags_json)
        except json.JSONDecodeError:
            tags = []
    return {
        "id": row.id,
        "project_id": row.project_id,
        "scenario_tags": tags,
        "run_id": row.run_id,
        "output_id": row.output_id,
        "feedback_id": row.feedback_id,
        "content_summary": row.content_summary,
        "iteration_of": row.iteration_of,
        "valid_until": row.valid_until,
        "kb_doc_id": row.kb_doc_id,
        "collection_name": row.collection_name,
        "created_at": row.created_at,
    }
