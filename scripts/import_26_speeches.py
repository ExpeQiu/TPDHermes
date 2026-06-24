#!/usr/bin/env python3
"""将 docs/26年发言稿.md 拆分并导入 public.release_assets.speeches。"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs" / "26年发言稿.md"
OUTPUT_DIR = ROOT / "data" / "kb_imports" / "speeches_2026"
MANIFEST_PATH = ROOT / "data" / "obsidian_imports" / "manifests" / "speeches_2026.manifest.json"
COLLECTION = "public.release_assets.speeches"

LEADER_RE = re.compile(r"^2026年.+讲稿$")
SPEECH_RE = re.compile(r"^(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])\s+\S")
SPECIAL_RES = (
    re.compile(r"^2026 CES 中方媒体QA"),
    re.compile(r"^2026 CES成吉利主场"),
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("import_26_speeches")


def slugify_ascii(text: str) -> str:
    normalized = unicodedata.normalize("NFKD", text)
    ascii_text = normalized.encode("ascii", "ignore").decode("ascii")
    cleaned = re.sub(r"[^A-Za-z0-9]+", "_", ascii_text).strip("_").lower()
    return cleaned or "doc"


def stable_doc_id(title: str, leader: str, line_no: int) -> str:
    key = f"{leader}|{title}|{line_no}"
    digest = hashlib.sha1(key.encode("utf-8")).hexdigest()[:12]
    slug = slugify_ascii(title)[:40]
    return f"obs_release_speeches_26_{slug}_{digest}"


def leader_folder(leader: str) -> str:
    name = leader.replace("2026年", "").replace("讲稿", "").strip() or leader
    return f"03-发布成果/26年发言稿/{name}"


def parse_sections(text: str) -> list[dict[str, Any]]:
    lines = text.splitlines()
    current_leader = "26年各领导讲稿"
    markers: list[tuple[int, str, str]] = []

    for i, line in enumerate(lines):
        s = line.strip()
        if not s:
            continue
        if LEADER_RE.match(s):
            current_leader = s
            continue
        if SPEECH_RE.match(s) or any(r.match(s) for r in SPECIAL_RES):
            markers.append((i, current_leader, s))

    sections: list[dict[str, Any]] = []
    for idx, (start, leader, title) in enumerate(markers):
        end = markers[idx + 1][0] if idx + 1 < len(markers) else len(lines)
        body_lines = lines[start:end]
        content = "\n".join(body_lines).strip()
        if not content:
            continue
        line_no = start + 1
        sections.append(
            {
                "line_no": line_no,
                "leader": leader,
                "title": title,
                "content": content,
                "doc_id": stable_doc_id(title, leader, line_no),
                "folder_path": leader_folder(leader),
            }
        )
    return sections


def write_split_files(sections: list[dict[str, Any]]) -> list[dict[str, Any]]:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    documents: list[dict[str, Any]] = []
    for sec in sections:
        safe_name = re.sub(r'[\\/:*?"<>|]', "_", sec["title"])[:80].strip() or sec["doc_id"]
        file_path = OUTPUT_DIR / f"{sec['line_no']:04d}_{safe_name}.md"
        header = f"# {sec['title']}\n\n> {sec['leader']}\n\n"
        file_path.write_text(header + sec["content"], encoding="utf-8")
        documents.append(
            {
                "doc_id": sec["doc_id"],
                "file_path": str(file_path),
                "title": sec["title"],
                "folder_path": sec["folder_path"],
                "tags": ["发布成果", "发言稿", "26年发言稿", sec["leader"]],
                "source_url": "",
            }
        )
        log.info("写入 %s (%s)", file_path.name, sec["title"][:48])
    return documents


def build_manifest(documents: list[dict[str, Any]]) -> dict[str, Any]:
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    manifest = {
        "batch_id": f"repo_import_speeches_2026_{ts}",
        "collection": COLLECTION,
        "defaults": {
            "domain": "release_assets",
            "folder_path": "03-发布成果/26年发言稿",
            "published": True,
            "source": "repo_import",
            "source_type": "file",
            "language": "zh",
            "tags": ["发布成果", "发言稿", "26年发言稿"],
        },
        "documents": documents,
    }
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    log.info("manifest 已写入 %s (%d 篇)", MANIFEST_PATH, len(documents))
    return manifest


def upload_and_ingest(
    manifest: dict[str, Any],
    *,
    api_base: str,
    user_id: str = "default",
    project_id: str = "__all__",
) -> dict[str, Any]:
    headers = {"X-User-Id": user_id}
    upload_ids: list[str] = []
    upload_doc_ids: dict[str, str] = {}

    with httpx.Client(timeout=120.0, headers=headers) as client:
        for doc in manifest["documents"]:
            file_path = Path(doc["file_path"])
            with file_path.open("rb") as handle:
                resp = client.post(
                    f"{api_base.rstrip('/')}/api/v1/kb/upload",
                    files={"file": (file_path.name, handle, "text/markdown")},
                    data={"doc_id": doc["doc_id"]},
                )
            resp.raise_for_status()
            body = resp.json()
            upload_id = body["upload_id"]
            upload_ids.append(upload_id)
            upload_doc_ids[upload_id] = doc["doc_id"]
            log.info("已上传 %s -> %s", doc["title"][:40], upload_id[:8])

        ingest_body = {
            "source_type": "upload",
            "collection": manifest["collection"],
            "project_id": project_id,
            "sync_cache": True,
            "upload_ids": upload_ids,
            "upload_doc_ids": upload_doc_ids,
            "defaults": manifest.get("defaults", {}),
            "batch_chunk_size": 64,
        }
        ingest_resp = client.post(f"{api_base.rstrip('/')}/api/v1/kb/ingest", json=ingest_body)
        ingest_resp.raise_for_status()
        report = ingest_resp.json()
        job_id = report.get("job_id")
        log.info("导入任务已创建 job_id=%s status=%s", job_id, report.get("status"))

        if job_id:
            for _ in range(120):
                job_resp = client.get(f"{api_base.rstrip('/')}/api/v1/kb/ingest-jobs/{job_id}")
                job_resp.raise_for_status()
                job = job_resp.json()
                status = job.get("status")
                if status in {"completed", "failed"}:
                    log.info(
                        "导入完成 status=%s doc=%s/%s chunk=%s",
                        status,
                        job.get("doc_succeeded"),
                        job.get("doc_total"),
                        job.get("chunk_upserted"),
                    )
                    if job.get("errors"):
                        log.warning("errors: %s", job["errors"])
                    return job
                import time

                time.sleep(1)
        return report


def main() -> int:
    parser = argparse.ArgumentParser(description="导入 docs/26年发言稿.md 到发言稿真源集合")
    parser.add_argument("--source", default=str(SOURCE), help="源 Markdown 路径")
    parser.add_argument("--split-only", action="store_true", help="仅拆分并生成 manifest")
    parser.add_argument("--api-base", default="http://47.113.225.93:8033", help="Hermes API 根地址")
    parser.add_argument("--user-id", default="default", help="X-User-Id")
    parser.add_argument("--project-id", default="__all__")
    args = parser.parse_args()

    source = Path(args.source).expanduser()
    if not source.is_file():
        log.error("源文件不存在: %s", source)
        return 2

    text = source.read_text(encoding="utf-8")
    sections = parse_sections(text)
    if not sections:
        log.error("未解析到任何发言稿段落")
        return 2

    log.info("解析到 %d 篇发言稿", len(sections))
    documents = write_split_files(sections)
    manifest = build_manifest(documents)

    if args.split_only:
        print(json.dumps({"manifest": str(MANIFEST_PATH), "documents": len(documents)}, ensure_ascii=False))
        return 0

    try:
        report = upload_and_ingest(
            manifest,
            api_base=args.api_base,
            user_id=args.user_id,
            project_id=args.project_id,
        )
    except httpx.HTTPError as exc:
        log.exception("云端导入失败: %s", exc)
        return 1

    report_path = MANIFEST_PATH.parent / "reports" / "speeches_2026.cloud_import.report.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    log.info("report 已写入 %s", report_path)

    failed = int(report.get("doc_failed") or 0)
    status = str(report.get("status") or "")
    if failed or status == "failed":
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
