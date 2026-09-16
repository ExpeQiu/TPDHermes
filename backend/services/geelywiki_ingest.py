"""
GeelyWiki LLMwiki 归档：读取 pages.json（全文+claims）切块入库并抽图谱。
"""

from __future__ import annotations

import json
import logging
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend.services.kb_contract import (
    AUTHORITY_CANONICAL,
    GEELYWIKI_PAGES_COLLECTION,
    SOURCE_GEELYWIKI,
)
from backend.services.kb_graph_pipeline import (
    RELATED_TO,
    apply_kg_bundle,
    slug_node_id,
)
from backend.services.kb_ingest_core import new_ingest_job_id, run_kb_ingestion, sha256_file
from backend.services.kb_proxy import CHROMA_HOST

logger = logging.getLogger("tpdx.hermes.geelywiki")

DEFAULT_PAGES_JSON = Path("/Volumes/Lexar/git/03T/GeelyWiki/dist/api/pages.json")
DEFAULT_ARCHIVE_ROOT = Path("/Volumes/DockerData/apps/tpdhermes/kb-archive/geelywiki")


def geelywiki_pages_json_path(explicit: str | None = None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    env = (os.getenv("GEELYWIKI_PAGES_JSON") or "").strip()
    if env:
        return Path(env).expanduser().resolve()
    return DEFAULT_PAGES_JSON


def geelywiki_archive_root(explicit: str | None = None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    env = (os.getenv("GEELYWIKI_ARCHIVE_ROOT") or "").strip()
    if env:
        return Path(env).expanduser().resolve()
    return DEFAULT_ARCHIVE_ROOT


def load_pages_json(path: Path) -> dict[str, Any]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("pages.json 必须是对象")
    pages = raw.get("pages")
    if not isinstance(pages, list):
        raise ValueError("pages.json 缺少 pages[]")
    return raw


def _claim_markdown(claim: dict[str, Any]) -> str:
    cid = str(claim.get("id") or "claim")
    statement = str(claim.get("statement") or "").strip()
    lines = [f"# claim {cid}", "", statement]
    for key in ("applies_to", "usage", "evidence_kind", "kind", "restriction", "source_as_of"):
        val = claim.get(key)
        if val:
            lines.append(f"- {key}: {val}")
    return "\n".join(lines) + "\n"


def pages_to_documents(pages: list[dict[str, Any]], staging: Path) -> list[dict[str, Any]]:
    """把 pages 写成 staging markdown，返回 ingestion documents（含 claims 独立文档）。"""
    staging.mkdir(parents=True, exist_ok=True)
    documents: list[dict[str, Any]] = []
    for page in pages:
        if not isinstance(page, dict):
            continue
        slug = str(page.get("slug") or "").strip()
        body = str(page.get("body") or "").strip()
        if not slug or len(body) < 8:
            logger.warning("geelywiki skip page missing body/slug slug=%s", slug or "?")
            continue
        title = str(page.get("title") or slug)
        wiki_type = str(page.get("type") or "")
        wiki_domain = str(page.get("domain") or "structured_tech")
        folder = f"geelywiki/{wiki_type or 'page'}"
        md_path = staging / f"{slug}.md"
        md_path.write_text(f"# {title}\n\n{body}\n", encoding="utf-8")
        base_meta = {
            "title": title,
            "domain": wiki_domain if wiki_domain in {"structured_tech", "release_assets", "internal_methodology", "public_intel", "market_research", "policy_regulation", "brand_map", "methodology"} else "structured_tech",
            "folder_path": folder,
            "source": SOURCE_GEELYWIKI,
            "source_type": "geelywiki",
            "published": True,
            "wiki_slug": slug,
            "wiki_type": wiki_type,
            "wiki_domain": wiki_domain,
            "layer": page.get("layer") or "",
            "publish_scope": page.get("publish_scope") or page.get("audience") or "",
            "authority": AUTHORITY_CANONICAL,
            "knowledge_status": page.get("knowledge_status") or "",
            "language": "zh",
        }
        documents.append({"doc_id": f"wiki_{slug}", "file_path": str(md_path), **base_meta})
        for claim in page.get("claims") or []:
            if not isinstance(claim, dict):
                continue
            cid = str(claim.get("id") or "").strip()
            statement = str(claim.get("statement") or "").strip()
            if not cid or not statement:
                continue
            cpath = staging / f"{slug}__claim_{cid}.md"
            cpath.write_text(_claim_markdown(claim), encoding="utf-8")
            documents.append(
                {
                    "doc_id": f"wiki_{slug}__claim_{cid}",
                    "file_path": str(cpath),
                    **base_meta,
                    "title": f"{title} · {cid}",
                    "folder_path": f"{folder}/claims",
                    "claim_id": cid,
                    "usage": str(claim.get("usage") or ""),
                    "evidence_kind": str(claim.get("evidence_kind") or ""),
                }
            )
    return documents


def _equipped_items(page: dict[str, Any]) -> list[dict[str, Any]]:
    raw = page.get("equipped_with") or []
    out: list[dict[str, Any]] = []
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, str) and item.strip():
                out.append({"slug": item.strip()})
            elif isinstance(item, dict) and item.get("slug"):
                out.append(item)
    return out


def _related_items(page: dict[str, Any]) -> list[dict[str, Any]]:
    raw = page.get("related_to") or []
    out: list[dict[str, Any]] = []
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, str) and item.strip():
                out.append({"slug": item.strip()})
            elif isinstance(item, dict) and item.get("slug"):
                out.append(item)
    return out


def pages_to_kg_bundle(pages: list[dict[str, Any]]) -> dict[str, Any]:
    brands: dict[str, dict[str, Any]] = {}
    vehicles_map: dict[str, dict[str, Any]] = {}
    techs: dict[str, dict[str, Any]] = {}
    relations: list[dict[str, Any]] = []

    default_brand = slug_node_id("wiki_brand", "geely")
    brands[default_brand] = {
        "brand_id": default_brand,
        "name_cn": "吉利",
        "source": SOURCE_GEELYWIKI,
        "domain": "brand_map",
    }

    for page in pages:
        if not isinstance(page, dict):
            continue
        slug = str(page.get("slug") or "").strip()
        if not slug:
            continue
        wiki_type = str(page.get("type") or "")
        title = str(page.get("title") or slug)
        if wiki_type == "concept" and str(page.get("domain") or "") in {"brand_map", ""}:
            bid = slug_node_id("wiki_brand", slug)
            brands[bid] = {
                "brand_id": bid,
                "name_cn": title,
                "source": SOURCE_GEELYWIKI,
                "domain": "brand_map",
            }
        if wiki_type == "product":
            tid = slug_node_id("wiki_tech", slug)
            techs[tid] = {
                "tech_id": tid,
                "brand_id": default_brand,
                "tech_text": title,
                "tech_category": str(page.get("domain") or "structured_tech"),
                "source": SOURCE_GEELYWIKI,
            }
        if wiki_type == "model":
            vid = slug_node_id("wiki_vehicle", slug)
            brand_id = default_brand
            related = page.get("related") or []
            if isinstance(related, list):
                for rel in related:
                    rslug = str(rel).strip()
                    if rslug.startswith("brand-"):
                        brand_id = slug_node_id("wiki_brand", rslug)
                        brands.setdefault(
                            brand_id,
                            {
                                "brand_id": brand_id,
                                "name_cn": rslug,
                                "source": SOURCE_GEELYWIKI,
                                "domain": "brand_map",
                            },
                        )
                        break
            vehicles_map[vid] = {
                "vehicle_id": vid,
                "brand_id": brand_id,
                "name": title,
                "source": SOURCE_GEELYWIKI,
            }
            relations.append(
                {
                    "rel_type": "OWNS",
                    "src_kind": "Brand",
                    "src_id": brand_id,
                    "dst_kind": "Vehicle",
                    "dst_id": vid,
                    "source": SOURCE_GEELYWIKI,
                    "authority": AUTHORITY_CANONICAL,
                    "source_collection": GEELYWIKI_PAGES_COLLECTION,
                }
            )
            for eq in _equipped_items(page):
                tslug = str(eq.get("slug") or "")
                tid = slug_node_id("wiki_tech", tslug)
                techs.setdefault(
                    tid,
                    {
                        "tech_id": tid,
                        "brand_id": brand_id,
                        "vehicle_name": title,
                        "tech_text": tslug,
                        "tech_category": str(eq.get("role") or "equipped"),
                        "source": SOURCE_GEELYWIKI,
                    },
                )
                relations.append(
                    {
                        "rel_type": "CONTAINS_TECH",
                        "src_kind": "Vehicle",
                        "src_id": vid,
                        "dst_kind": "CoreTech",
                        "dst_id": tid,
                        "source": SOURCE_GEELYWIKI,
                        "authority": AUTHORITY_CANONICAL,
                        "source_collection": GEELYWIKI_PAGES_COLLECTION,
                        "evidence_kind": "equipped_with",
                    }
                )
            for rel in _related_items(page):
                tslug = str(rel.get("slug") or "")
                tid = slug_node_id("wiki_tech", tslug)
                techs.setdefault(
                    tid,
                    {
                        "tech_id": tid,
                        "brand_id": brand_id,
                        "vehicle_name": title,
                        "tech_text": tslug,
                        "tech_category": str(rel.get("role") or "related"),
                        "source": SOURCE_GEELYWIKI,
                    },
                )
                relations.append(
                    {
                        "rel_type": RELATED_TO,
                        "src_kind": "Vehicle",
                        "src_id": vid,
                        "dst_kind": "CoreTech",
                        "dst_id": tid,
                        "source": SOURCE_GEELYWIKI,
                        "authority": AUTHORITY_CANONICAL,
                        "source_collection": GEELYWIKI_PAGES_COLLECTION,
                        "evidence_kind": "related_to",
                    }
                )

    return {
        "brands": list(brands.values()),
        "vehicles": list(vehicles_map.values()),
        "core_techs": list(techs.values()),
        "tech_insights": [],
        "relations": relations,
    }


def snapshot_payload(
    payload: dict[str, Any],
    archive_root: Path,
    build_id: str,
    *,
    source_label: str,
) -> Path:
    dest = archive_root / build_id
    dest.mkdir(parents=True, exist_ok=True)
    pages_path = dest / "pages.json"
    pages_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    (dest / "ingest_meta.json").write_text(
        json.dumps(
            {
                "build_id": build_id,
                "source": source_label,
                "checksum": sha256_file(pages_path),
                "data_source": payload.get("data_source"),
                "fetched_at": payload.get("fetched_at"),
                "page_count": len(payload.get("pages") or []),
                "archived_at": datetime.now(timezone.utc).isoformat(),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    logger.info("geelywiki snapshot dest=%s source=%s", dest, source_label)
    return dest


def snapshot_geelywiki_export(
    pages_json: Path,
    archive_root: Path,
    build_id: str,
) -> Path:
    dest = snapshot_payload(load_pages_json(pages_json), archive_root, build_id, source_label=str(pages_json))
    for sibling in ("llms.txt", "llms-full.txt", "profile.json"):
        src = pages_json.parent / sibling if sibling == "profile.json" else pages_json.parent.parent / sibling
        if src.is_file():
            shutil.copy2(src, dest / sibling)
    return dest


def build_geelywiki_manifest(
    pages_json: Path,
    staging: Path,
) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    payload = load_pages_json(pages_json)
    pages = [p for p in payload.get("pages") or [] if isinstance(p, dict)]
    documents = pages_to_documents(pages, staging)
    kg_bundle = pages_to_kg_bundle(pages)
    batch_id = new_ingest_job_id()
    manifest = {
        "batch_id": batch_id,
        "collection": GEELYWIKI_PAGES_COLLECTION,
        "defaults": {
            "source": SOURCE_GEELYWIKI,
            "source_type": "geelywiki",
            "published": True,
            "language": "zh",
            "domain": "structured_tech",
            "folder_path": "geelywiki",
            "authority": AUTHORITY_CANONICAL,
        },
        "documents": documents,
    }
    return manifest, kg_bundle, pages


def ingest_geelywiki(
    *,
    pages_json: Path | None = None,
    archive_root: Path | None = None,
    chroma_url: str | None = None,
    apply: bool = False,
    staging: Path | None = None,
    from_cli: bool = False,
    demo: bool = False,
) -> dict[str, Any]:
    build_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    arch = geelywiki_archive_root(str(archive_root) if archive_root else None)
    source_label = "cli"
    if from_cli or demo:
        from backend.services.geelywiki_cli import GeelyWikiCliError, fetch_pages_via_cli

        try:
            payload = fetch_pages_via_cli(demo=demo)
        except GeelyWikiCliError as exc:
            logger.exception("geelywiki cli fetch failed")
            return {"ok": False, "error": str(exc), "source": "cli"}
        source_label = f"cli:{payload.get('data_source') or 'live'}"
        snap = snapshot_payload(payload, arch, build_id, source_label=source_label)
        src = snap / "pages.json"
    else:
        src = geelywiki_pages_json_path(str(pages_json) if pages_json else None)
        if not src.is_file():
            return {"ok": False, "error": f"pages.json 不存在: {src}"}
        payload = load_pages_json(src)
        source_label = str(src)
        snap = snapshot_geelywiki_export(src, arch, build_id)

    if payload.get("pages") and any(
        isinstance(p, dict) and not str(p.get("body") or "").strip()
        for p in payload["pages"]
        if isinstance(p, dict) and p.get("slug") == "model-galaxy-xingyao-7"
    ):
        logger.warning("geelywiki xingyao page missing body; ingest still proceeds for other pages")

    stage = staging or (snap / "staging")
    manifest, kg_bundle, pages = build_geelywiki_manifest(src, stage)
    chroma = (chroma_url or os.getenv("CHROMA_HOST") or CHROMA_HOST).strip()
    ingest_report = run_kb_ingestion(
        manifest=manifest,
        collection=GEELYWIKI_PAGES_COLLECTION,
        chroma_url=chroma,
        job_id=build_id,
        dry_run=not apply,
    )
    return {
        "ok": ingest_report.get("status") != "failed",
        "build_id": build_id,
        "snapshot": str(snap),
        "page_count": len(pages),
        "doc_count": len(manifest["documents"]),
        "claim_docs": sum(1 for d in manifest["documents"] if d.get("claim_id")),
        "ingest": ingest_report,
        "kg_bundle": kg_bundle,
        "publish_scope": payload.get("publish_scope"),
        "apply": apply,
        "source": source_label,
        "data_source": payload.get("data_source"),
    }


async def apply_geelywiki_graph(kg_bundle: dict[str, Any]) -> dict[str, int]:
    from backend.services.kb_graph_pipeline import link_kb_to_kg

    counts = await apply_kg_bundle(kg_bundle, kb_entry_id=None)
    for v in kg_bundle.get("vehicles") or []:
        if not isinstance(v, dict):
            continue
        vid = str(v.get("vehicle_id") or "")
        slug = vid.replace("wiki_vehicle_", "", 1)
        if vid:
            await link_kb_to_kg(
                kb_entry_id=f"wiki_{slug}",
                kg_kind="Vehicle",
                kg_node_id=vid,
            )
            counts["links"] = counts.get("links", 0) + 1
    for t in kg_bundle.get("core_techs") or []:
        if not isinstance(t, dict):
            continue
        tid = str(t.get("tech_id") or "")
        slug = tid.replace("wiki_tech_", "", 1)
        if tid:
            await link_kb_to_kg(
                kb_entry_id=f"wiki_{slug}",
                kg_kind="CoreTech",
                kg_node_id=tid,
            )
            counts["links"] = counts.get("links", 0) + 1
    logger.info("geelywiki graph applied counts=%s", counts)
    return counts
