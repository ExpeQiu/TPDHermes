#!/usr/bin/env python3
"""历史项目附件与输出沉淀批量写入 project.{id}.kb。"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from sqlalchemy import select

from backend.db import async_session_maker
from backend.models.output_asset import OutputAsset
from backend.models.project_attachment import ProjectAttachment
from backend.services.project_kb_ingest import ingest_project_attachment, ingest_project_output

logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(message)s")
log = logging.getLogger("backfill_project_kb")


async def run_backfill(*, attachments: bool, outputs: bool, dry_run: bool) -> dict:
    report: dict = {"attachments": [], "outputs": [], "ok": 0, "failed": 0}
    async with async_session_maker() as db:
        if attachments:
            rows = (await db.execute(select(ProjectAttachment))).scalars().all()
            for row in rows:
                item = {"id": row.id, "project_id": row.project_id}
                if dry_run:
                    report["attachments"].append({**item, "dry_run": True})
                    continue
                res = await ingest_project_attachment(row.id)
                item["ok"] = res.ok
                item["message"] = res.message
                report["attachments"].append(item)
                if res.ok:
                    report["ok"] += 1
                else:
                    report["failed"] += 1

        if outputs:
            q = await db.execute(
                select(OutputAsset).where(OutputAsset.status != "archived")
            )
            rows = q.scalars().all()
            for row in rows:
                item = {"id": row.id, "project_id": row.project_id, "status": row.status}
                if dry_run:
                    report["outputs"].append({**item, "dry_run": True})
                    continue
                res = await ingest_project_output(row.id)
                item["ok"] = res.ok
                item["message"] = res.message
                report["outputs"].append(item)
                if res.ok:
                    report["ok"] += 1
                else:
                    report["failed"] += 1

    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Backfill project KB from attachments/outputs")
    parser.add_argument("--attachments", action="store_true", help="Include attachments")
    parser.add_argument("--outputs", action="store_true", help="Include outputs")
    parser.add_argument("--all", action="store_true", help="Include both")
    parser.add_argument("--dry-run", action="store_true", help="List targets only")
    args = parser.parse_args()
    do_att = args.attachments or args.all
    do_out = args.outputs or args.all
    if not do_att and not do_out:
        do_att = do_out = True
    report = asyncio.run(run_backfill(attachments=do_att, outputs=do_out, dry_run=args.dry_run))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
