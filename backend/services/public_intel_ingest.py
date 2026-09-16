"""
外部情报（战略 / 车型库 / 技术库）抽图：弱权威，禁止 CONTAINS_TECH 搭载边。
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

from backend.services.kb_contract import (
    AUTHORITY_SUPPLEMENT,
    PUBLIC_INTEL_STRATEGY_COLLECTION,
    PUBLIC_INTEL_TECH_COLLECTION,
    PUBLIC_INTEL_VEHICLE_COLLECTION,
    SOURCE_PUBLIC_INTEL,
    SOURCE_WEB,
    is_public_intel_collection,
)
from backend.services.kb_graph_pipeline import apply_kg_bundle, slug_node_id

logger = logging.getLogger("tpdx.hermes.public_intel")

_BRAND_LINE = re.compile(r"品牌[：:]\s*(\S+)")
_VEHICLE_LINE = re.compile(r"车型[：:]\s*(\S+)")


def _first_heading(text: str) -> str:
    for line in (text or "").splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            return stripped.lstrip("#").strip()
    return ""


def document_to_intel_bundle(
    *,
    collection: str,
    doc_id: str,
    title: str,
    body: str,
    meta: dict[str, Any],
) -> dict[str, Any]:
    source = str(meta.get("source") or SOURCE_PUBLIC_INTEL)
    if source not in {SOURCE_PUBLIC_INTEL, SOURCE_WEB}:
        source = SOURCE_PUBLIC_INTEL if collection != PUBLIC_INTEL_TECH_COLLECTION else SOURCE_WEB
    brand_name = str(meta.get("brand") or "").strip()
    vehicle_name = str(meta.get("vehicle_name") or "").strip()
    if not brand_name:
        m = _BRAND_LINE.search(body)
        if m:
            brand_name = m.group(1)
    if not vehicle_name:
        m = _VEHICLE_LINE.search(body)
        if m:
            vehicle_name = m.group(1)
    if not brand_name:
        brand_name = title.split()[0] if title else "unknown"
    brand_id = str(meta.get("brand_id") or slug_node_id("intel_brand", brand_name))
    bundle: dict[str, Any] = {
        "brands": [
            {
                "brand_id": brand_id,
                "name_cn": brand_name,
                "source": source,
                "domain": "public_intel",
            }
        ],
        "vehicles": [],
        "core_techs": [],
        "tech_insights": [],
        "relations": [],
    }

    if collection == PUBLIC_INTEL_VEHICLE_COLLECTION:
        vid = slug_node_id("intel_vehicle", vehicle_name or doc_id)
        bundle["vehicles"].append(
            {
                "vehicle_id": vid,
                "brand_id": brand_id,
                "name": vehicle_name or title,
                "source": SOURCE_PUBLIC_INTEL,
            }
        )
        bundle["relations"].append(
            {
                "rel_type": "OWNS",
                "src_kind": "Brand",
                "src_id": brand_id,
                "dst_kind": "Vehicle",
                "dst_id": vid,
                "source": SOURCE_PUBLIC_INTEL,
                "authority": AUTHORITY_SUPPLEMENT,
                "source_collection": collection,
                "evidence_kind": "third_party",
            }
        )
    elif collection == PUBLIC_INTEL_STRATEGY_COLLECTION:
        iid = slug_node_id("intel_insight", doc_id)
        bundle["tech_insights"].append(
            {
                "insight_id": iid,
                "brand_id": brand_id,
                "s_level": title,
                "source": SOURCE_PUBLIC_INTEL,
            }
        )
        bundle["relations"].append(
            {
                "rel_type": "HAS_INSIGHT",
                "src_kind": "Brand",
                "src_id": brand_id,
                "dst_kind": "TechInsight",
                "dst_id": iid,
                "source": SOURCE_PUBLIC_INTEL,
                "authority": AUTHORITY_SUPPLEMENT,
                "source_collection": collection,
                "evidence_kind": "third_party",
            }
        )
    else:
        tid = slug_node_id("intel_tech", doc_id)
        iid = slug_node_id("intel_insight", doc_id)
        bundle["core_techs"].append(
            {
                "tech_id": tid,
                "brand_id": brand_id,
                "tech_text": title,
                "tech_category": "web",
                "insight_id": iid,
                "source": SOURCE_WEB,
            }
        )
        bundle["tech_insights"].append(
            {
                "insight_id": iid,
                "brand_id": brand_id,
                "s_level": title,
                "source": SOURCE_WEB,
            }
        )
        bundle["relations"].append(
            {
                "rel_type": "HAS_INSIGHT",
                "src_kind": "Brand",
                "src_id": brand_id,
                "dst_kind": "TechInsight",
                "dst_id": iid,
                "source": SOURCE_WEB,
                "authority": AUTHORITY_SUPPLEMENT,
                "source_collection": collection,
                "evidence_kind": "web",
            }
        )
    return bundle


async def graph_after_public_ingest(collection: str, manifest: dict[str, Any]) -> dict[str, Any]:
    if not is_public_intel_collection(collection):
        return {"skipped": True}
    totals: dict[str, int] = {}
    for doc in manifest.get("documents") or []:
        if not isinstance(doc, dict):
            continue
        path = Path(str(doc.get("file_path") or ""))
        body = ""
        if path.is_file():
            try:
                body = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                body = ""
        title = str(doc.get("title") or _first_heading(body) or path.stem)
        doc_id = str(doc.get("doc_id") or path.stem)
        try:
            bundle = document_to_intel_bundle(
                collection=collection,
                doc_id=doc_id,
                title=title,
                body=body,
                meta=doc,
            )
            counts = await apply_kg_bundle(bundle, kb_entry_id=doc_id)
            for k, n in counts.items():
                totals[k] = totals.get(k, 0) + n
        except Exception:
            logger.exception("public intel graph failed collection=%s doc_id=%s", collection, doc_id)
    logger.info("public intel graph collection=%s totals=%s", collection, totals)
    return {"ok": True, "collection": collection, "counts": totals}
