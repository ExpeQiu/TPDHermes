"""Autocar Wiki：经 MCP 拉取页面并写入独立集合，不并入 GeelyWiki 图谱。"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend.services.geelywiki_ingest import pages_to_documents, snapshot_payload
from backend.services.kb_contract import SOURCE_AUTOCAR, autocar_import_target
from backend.services.kb_ingest_core import new_ingest_job_id, run_kb_ingestion
from backend.services.kb_proxy import CHROMA_HOST

logger = logging.getLogger("tpdx.hermes.autocar")

DEFAULT_ARCHIVE_ROOT = Path("/Volumes/DockerData/apps/tpdhermes/kb-archive/autocar")


def autocar_archive_root(explicit: str | None = None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    env = (os.getenv("AUTOCAR_ARCHIVE_ROOT") or "").strip()
    if env:
        return Path(env).expanduser().resolve()
    return DEFAULT_ARCHIVE_ROOT


def ingest_autocar(
    *,
    archive_root: Path | None = None,
    chroma_url: str | None = None,
    apply: bool = False,
    demo: bool = False,
    import_scope: str = "external",
) -> dict[str, Any]:
    from backend.services.autocar_cli_config import resolve_autocar_mcp
    from backend.services.geelywiki_mcp import GeelyWikiMcpError, fetch_pages_via_mcp

    collection, authority = autocar_import_target(import_scope)
    build_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    arch = autocar_archive_root(str(archive_root) if archive_root else None)
    target = str(resolve_autocar_mcp().get("url") or "").strip()
    try:
        payload = fetch_pages_via_mcp(demo=demo, url=target)
    except GeelyWikiMcpError as exc:
        logger.exception("autocar mcp fetch failed")
        return {"ok": False, "error": str(exc), "source": "mcp", "import_scope": import_scope}
    source_label = f"mcp:{payload.get('data_source') or 'live'}"
    snap = snapshot_payload(payload, arch, build_id, source_label=source_label)
    stage = snap / "staging"
    pages = [page for page in (payload.get("pages") or []) if isinstance(page, dict)]
    documents = pages_to_documents(
        pages,
        stage,
        authority=authority,
        source=SOURCE_AUTOCAR,
        source_type="autocar",
        folder_prefix="autocar",
        doc_prefix="autocar",
    )
    manifest = {
        "batch_id": new_ingest_job_id(),
        "collection": collection,
        "defaults": {
            "source": SOURCE_AUTOCAR,
            "source_type": "autocar",
            "published": True,
            "language": "zh",
            "domain": "structured_tech",
            "folder_path": "autocar",
            "authority": authority,
        },
        "documents": documents,
    }
    chroma = (chroma_url or os.getenv("CHROMA_HOST") or CHROMA_HOST).strip()
    logger.info(
        "autocar ingest scope=%s collection=%s authority=%s apply=%s pages=%s",
        import_scope,
        collection,
        authority,
        apply,
        len(pages),
    )
    ingest_report = run_kb_ingestion(
        manifest=manifest,
        collection=collection,
        chroma_url=chroma,
        job_id=build_id,
        dry_run=not apply,
    )
    return {
        "ok": ingest_report.get("status") != "failed",
        "build_id": build_id,
        "snapshot": str(snap),
        "page_count": len(pages),
        "doc_count": len(documents),
        "claim_docs": sum(1 for doc in documents if doc.get("claim_id")),
        "ingest": ingest_report,
        "graph_skipped": True,
        "apply": apply,
        "import_scope": import_scope,
        "collection": collection,
        "source": source_label,
        "data_source": payload.get("data_source"),
    }
