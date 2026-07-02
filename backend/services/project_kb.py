"""项目级知识库 collection 命名与编排合并。"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.output_asset import OutputAsset
from backend.models.project_attachment import ProjectAttachment
from backend.models.project_config import ProjectConfig
from backend.services.kb_contract import KB_AUTHORITATIVE_COLLECTIONS

logger = logging.getLogger("tpdx.hermes.project_kb")

PROJECT_KB_PREFIX = "project."


def project_kb_ingest_enabled() -> bool:
    raw = os.getenv("PROJECT_KB_INGEST_ENABLED", "1").strip().lower()
    return raw not in ("0", "false", "no", "off")


def project_kb_collection(project_id: str) -> str:
    pid = str(project_id or "").strip()
    if not pid:
        raise ValueError("project_id required")
    return f"{PROJECT_KB_PREFIX}{pid}.kb"


def is_project_kb_collection(collection_name: str) -> bool:
    name = str(collection_name or "").strip()
    return name.startswith(PROJECT_KB_PREFIX) and name.endswith(".kb")


def project_id_from_kb_collection(collection_name: str) -> str | None:
    name = str(collection_name or "").strip()
    if not is_project_kb_collection(name):
        return None
    return name[len(PROJECT_KB_PREFIX) : -len(".kb")] or None


def attachment_doc_id(attachment_id: str) -> str:
    return f"att_{attachment_id}"


def output_doc_id(output_id: str) -> str:
    return f"out_{output_id}"


# /chat 绑定项目但项目 KB 无索引时，补充的公共检索范围
CHAT_KB_FALLBACK_COLLECTIONS: tuple[str, ...] = (
    *sorted(KB_AUTHORITATIVE_COLLECTIONS),
    "public.structured_tech.geely_tech",
)


def merge_chat_kb_fallback_collections(collections: list[str]) -> list[str]:
    """项目 KB 为空时 union 公共知识库集合（去重保序）。"""
    out: list[str] = []
    seen: set[str] = set()
    for c in [*collections, *CHAT_KB_FALLBACK_COLLECTIONS]:
        s = str(c or "").strip()
        if s and s not in seen:
            seen.add(s)
            out.append(s)
    return out


async def count_project_kb_indexed(db: AsyncSession, project_id: str) -> int:
    """统计项目内已入库 KB 的附件与输出物数量。"""
    pid = str(project_id or "").strip()
    if not pid:
        return 0
    att_count = (
        await db.execute(
            select(func.count())
            .select_from(ProjectAttachment)
            .where(
                ProjectAttachment.project_id == pid,
                ProjectAttachment.ingest_status == "ingested",
            )
        )
    ).scalar_one()
    out_count = (
        await db.execute(
            select(func.count())
            .select_from(OutputAsset)
            .where(
                OutputAsset.project_id == pid,
                OutputAsset.status != "archived",
                OutputAsset.kb_ingest_status == "ingested",
            )
        )
    ).scalar_one()
    return int(att_count or 0) + int(out_count or 0)


def merge_project_kb_collections(collections: list[str], project_id: str | None) -> list[str]:
    """将 project.{id}.kb union 进 collections（去重保序）。"""
    pid = str(project_id or "").strip()
    if not pid or pid == "none":
        return list(collections)
    col = project_kb_collection(pid)
    out: list[str] = []
    seen: set[str] = set()
    for c in [col, *collections]:
        s = str(c or "").strip()
        if s and s not in seen:
            seen.add(s)
            out.append(s)
    return out


def output_published_for_status(status: str | None) -> bool:
    st = (status or "").strip().lower()
    if st in ("draft", "archived"):
        return False
    return True


async def ensure_project_kb_collection_in_config(db: AsyncSession, project_id: str) -> None:
    """upsert project_configs.defaults_json.knowledge.collections。"""
    pid = str(project_id).strip()
    col = project_kb_collection(pid)
    res = await db.execute(select(ProjectConfig).where(ProjectConfig.project_id == pid))
    row = res.scalar_one_or_none()
    now = datetime.now().isoformat()
    defaults: dict = {}
    if row and row.defaults_json:
        try:
            parsed = json.loads(row.defaults_json)
            defaults = parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            defaults = {}
    knowledge = defaults.get("knowledge")
    if not isinstance(knowledge, dict):
        knowledge = {}
    cols = knowledge.get("collections")
    if not isinstance(cols, list):
        cols = []
    merged = merge_project_kb_collections([str(x) for x in cols if x], pid)
    knowledge = {
        **knowledge,
        "collections": merged,
        "project_bound": knowledge.get("project_bound", True),
        "mode": knowledge.get("mode", "restricted"),
    }
    defaults["knowledge"] = knowledge
    payload = json.dumps(defaults, ensure_ascii=False)
    if row:
        row.defaults_json = payload
        row.updated_at = now
    else:
        db.add(ProjectConfig(project_id=pid, defaults_json=payload, updated_at=now))
    await db.commit()
    logger.info("project_kb config ensured project=%s collection=%s", pid[:24], col)
