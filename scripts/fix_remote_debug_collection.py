#!/usr/bin/env python3
"""删除损坏的 remote_debug collection 并重新 ingest。"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import httpx

ROOT = Path("/app") if Path("/app/backend").is_dir() else Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

COLLECTION = "public.structured_tech.remote_debug"
CHROMA_URL = "http://chroma:8000"
MD_PATH = Path("/app/data/kb_uploads/harvest/harvest_ffc0ea844b74ac40.md")


def main() -> int:
    from backend.services.chroma_client import ChromaHttpClient, flatten_chroma_get_ids
    from backend.services.kb_write import add_kb_harvest_entry

    r = httpx.delete(f"{CHROMA_URL}/api/v1/collections/{COLLECTION}", timeout=120)
    print(f"delete status={r.status_code}", flush=True)

    if not MD_PATH.is_file():
        print(f"ERROR: markdown not found: {MD_PATH}", flush=True)
        return 1

    body = MD_PATH.read_text(encoding="utf-8")
    lines = body.splitlines()
    title = lines[0].lstrip("#").strip() if lines else "8033 远程联调文档"
    content = "\n".join(lines[1:]).strip() if len(lines) > 1 else body

    async def run() -> dict:
        return await add_kb_harvest_entry(
            collection_name=COLLECTION,
            project_id="__all__",
            title=title,
            content=content,
            summary="TPDHermes 阿里云 8033 端口远程联调验收文档",
            domain="structured_tech",
            source="ops_remote_debug",
            published=True,
            metadata={"harvested_from_user_confirmed": True, "created_by": "ops"},
        )

    result = asyncio.run(run())
    print(f"ingest ok={result.get('ok')} chunks={result.get('chunk_count')}", flush=True)

    client = ChromaHttpClient(CHROMA_URL)
    data = client.get_by_where(COLLECTION, {}, limit=20, include=["metadatas"])
    ids = flatten_chroma_get_ids(data)
    print(f"verify docs={len(ids)}", flush=True)
    if ids:
        metas = data.get("metadatas") or []
        if metas and isinstance(metas[0], list) and metas[0]:
            print(f"sample title={metas[0][0].get('title')}", flush=True)
    return 0 if result.get("ok") and ids else 1


if __name__ == "__main__":
    raise SystemExit(main())
