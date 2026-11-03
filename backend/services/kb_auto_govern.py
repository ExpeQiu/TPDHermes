"""按已发布知识策略，把需治理的目录节点归到允许的业务域和目录。"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any

from sqlalchemy import select

from backend.db import async_session_maker
from backend.models.kb_cache import KBCache
from backend.services.kb_ids import kb_doc_id_from_ref

logger = logging.getLogger("tpdx.hermes")

DOMAIN_ROOT_FOLDER: dict[str, str] = {
    "public_intel": "01-汽车信息库",
    "structured_tech": "02-知识库",
    "release_assets": "03-发布成果",
    "market_research": "04-市场研究",
    "policy_regulation": "05-政策法规",
    "internal_methodology": "06-内部方法论",
}

REASON_LABELS = {
    "missing_domain": "未设置业务域",
    "missing_folder": "缺少目录路径",
    "domain_outside_policy": "不在策略允许的业务域",
}


def _as_domain_list(config: dict[str, Any]) -> list[str]:
    raw = config.get("eligible_domains")
    if not isinstance(raw, list):
        return []
    seen: list[str] = []
    for item in raw:
        text = str(item).strip()
        if text and text != "_uncategorized" and text not in seen:
            seen.append(text)
    return seen


def _folder_override(config: dict[str, Any]) -> str:
    for key in ("govern_folder_path", "folder_path"):
        raw = config.get(key)
        if isinstance(raw, str) and raw.strip():
            return raw.strip().strip("/")
    return ""


def govern_reasons(domain: str, folder: str, eligible: set[str]) -> list[str]:
    reasons: list[str] = []
    if not domain or domain == "_uncategorized":
        reasons.append("missing_domain")
    elif eligible and domain not in eligible:
        reasons.append("domain_outside_policy")
    if not folder:
        reasons.append("missing_folder")
    return reasons


def plan_target(
    domain: str,
    folder: str,
    eligible: list[str],
    folder_override: str,
) -> tuple[str, str] | None:
    allowed = set(eligible)
    domain_ok = bool(domain) and domain != "_uncategorized" and (not allowed or domain in allowed)
    target_domain = domain if domain_ok else (eligible[0] if eligible else "")
    if not target_domain:
        return None
    if folder and domain_ok:
        target_folder = folder
    elif folder_override:
        target_folder = folder_override
    else:
        target_folder = DOMAIN_ROOT_FOLDER.get(target_domain, f"02-知识库/{target_domain}")
    if target_domain == domain and target_folder == folder:
        return None
    return target_domain, target_folder


def _meta_dict(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


async def run_auto_govern(policy_id: str, *, dry_run: bool) -> dict[str, Any]:
    from backend.services.knowledge_policy_store import get_policy, loads_json_dict

    async with async_session_maker() as db:
        policy = await get_policy(db, policy_id)
        if not policy:
            return {"ok": False, "message": "policy_not_found"}
        if policy.status != "published":
            return {"ok": False, "message": "policy_not_published"}
        config = loads_json_dict(policy.config_json)
        eligible = _as_domain_list(config)
        override = _folder_override(config)
        rows = (await db.execute(select(KBCache.id, KBCache.metadata_).limit(8000))).all()

        planned: dict[str, tuple[str, str, tuple[str, ...], str, str]] = {}
        for row_id, raw_meta in rows:
            doc_id = kb_doc_id_from_ref(str(row_id))
            if not doc_id or doc_id in planned:
                continue
            meta = _meta_dict(raw_meta)
            domain = str(meta.get("domain") or "").strip() or "_uncategorized"
            folder = str(meta.get("folder_path") or "").strip().strip("/")
            reasons = govern_reasons(domain, folder, set(eligible))
            if not reasons:
                continue
            target = plan_target(domain, folder, eligible, override)
            if not target:
                continue
            planned[doc_id] = (target[0], target[1], tuple(reasons), domain, folder)

        groups: dict[tuple[str, str, str, str, tuple[str, ...]], int] = {}
        for _doc, (to_domain, to_folder, reasons, from_domain, from_folder) in planned.items():
            key = (from_domain, from_folder, to_domain, to_folder, reasons)
            groups[key] = groups.get(key, 0) + 1

        updated = 0
        chroma_failed = 0
        if not dry_run and planned:
            now = datetime.now().isoformat()
            cache_rows = (await db.execute(select(KBCache).limit(8000))).scalars().all()
            pending = []
            for row in cache_rows:
                doc_id = kb_doc_id_from_ref(str(row.source_chunk_id or row.id))
                plan = planned.get(doc_id)
                if not plan:
                    continue
                meta = _meta_dict(row.metadata_)
                meta["domain"] = plan[0]
                meta["folder_path"] = plan[1]
                meta["governed_by_policy"] = policy.id
                source_id = str(row.source_chunk_id or row.id)
                pending.append((row, meta, source_id))
            try:
                from backend.services.chroma_client import ChromaHttpClient
                from backend.services.kb_proxy import CHROMA_HOST

                client = ChromaHttpClient(CHROMA_HOST)
                if not client.heartbeat():
                    raise RuntimeError("chroma_unavailable")
                grouped: dict[str, list[tuple[str, dict]]] = {}
                for _row, meta, source_id in pending:
                    grouped.setdefault(str(_row.collection), []).append((source_id, meta))
                for collection_name, items in grouped.items():
                    client.update(
                        collection_name,
                        [item[0] for item in items],
                        [item[1] for item in items],
                    )
            except Exception as exc:
                logger.warning("kb auto_govern chroma write failed: %s", exc)
                chroma_failed = len(pending)
                pending = []
            for row, meta, _source_id in pending:
                row.metadata_ = json.dumps(meta, ensure_ascii=False)
                row.updated_at = now
                row.version = int(row.version or 1) + 1
                updated += 1
            if updated:
                await db.commit()

        policy_view = {"id": policy.id, "code": policy.code, "name": policy.name}

    nodes = [
        {
            "from_domain": key[0],
            "from_folder": key[1] or "（域根）",
            "to_domain": key[2],
            "to_folder": key[3],
            "reasons": [REASON_LABELS.get(item, item) for item in key[4]],
            "doc_count": count,
        }
        for key, count in sorted(groups.items(), key=lambda item: -item[1])
    ]
    logger.info(
        "kb auto_govern policy_id=%s policy_code=%s dry_run=%s eligible_domains=%s docs=%s nodes=%s updated_rows=%s",
        policy_view["id"],
        policy_view["code"],
        dry_run,
        ",".join(eligible),
        len(planned),
        len(nodes),
        updated,
    )
    return {
        "ok": chroma_failed == 0,
        "chroma_failed": chroma_failed,
        "dry_run": dry_run,
        "policy": policy_view,
        "eligible_domains": eligible,
        "nodes": nodes,
        "doc_count": len(planned),
        "updated_rows": updated,
    }
