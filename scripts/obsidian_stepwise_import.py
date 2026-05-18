#!/usr/bin/env python3
"""
分步执行 Obsidian -> TPDHermes 知识库导入。
"""

from __future__ import annotations

import argparse
import os
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import httpx


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS_DIR = ROOT / "scripts"
DEFAULT_OUTPUT_DIR = ROOT / "data" / "obsidian_imports" / "manifests"
BUILD_SCRIPT = SCRIPTS_DIR / "build_obsidian_manifest.py"
INGEST_SCRIPT = SCRIPTS_DIR / "kb_ingest.py"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Stepwise import for Obsidian markdown knowledge base")
    parser.add_argument(
        "--steps",
        default="build,dry-run,local-import",
        help="逗号分隔的步骤：build,dry-run,local-import,cloud-upload,cloud-ingest-only,cloud-import",
    )
    parser.add_argument("--vault-root", help="Obsidian 知识库根目录")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR), help="manifest 输出目录")
    parser.add_argument("--python", default=sys.executable, help="Python 可执行文件")
    parser.add_argument("--chroma-url", default="http://localhost:8001", help="本地 Chroma 地址")
    parser.add_argument("--hermes-api", default="http://localhost:8000", help="本地 Hermes API 地址")
    parser.add_argument("--project-id", default="__all__", help="本地 cache sync 的 project_id")
    parser.add_argument("--batch-chunk-size", type=int, default=64, help="每批 upsert 的 chunk 数")
    parser.add_argument("--strict-domain", action="store_true", help="启用 domain 枚举校验")
    parser.add_argument("--only", action="append", default=[], help="仅执行指定 target 名称，可重复传入")
    parser.add_argument("--cloud-api-base", help="云端 Hermes API 根地址")
    parser.add_argument(
        "--cloud-api-key",
        default=(
            os.getenv("CLOUD_TPDHERMES_API_KEY", "").strip()
            or os.getenv("HERMES_API_KEY", "").strip()
            or os.getenv("X_API_KEY", "").strip()
            or os.getenv("API_SERVER_KEY", "").strip()
        ),
        help="云端 API Key；如需鉴权将作为 X-API-Key 发送",
    )
    parser.add_argument("--cloud-project-id", default="__all__", help="云端 ingest 的 project_id")
    parser.add_argument("--cloud-chroma-url", help="云端 Chroma 地址，透传给云端 ingest")
    return parser.parse_args()


def normalize_steps(raw_steps: str) -> list[str]:
    valid = {"build", "dry-run", "local-import", "cloud-upload", "cloud-ingest-only", "cloud-import"}
    steps = [step.strip() for step in raw_steps.split(",") if step.strip()]
    unknown = [step for step in steps if step not in valid]
    if unknown:
        raise SystemExit(f"不支持的步骤: {', '.join(unknown)}")
    return steps


def run_command(cmd: list[str]) -> None:
    print(f"$ {' '.join(cmd)}")
    subprocess.run(cmd, check=True, cwd=ROOT)


def build_manifests(args: argparse.Namespace) -> dict[str, Any]:
    cmd = [args.python, str(BUILD_SCRIPT), "--output-dir", args.output_dir]
    if args.vault_root:
        cmd.extend(["--vault-root", args.vault_root])
    run_command(cmd)
    return load_index(Path(args.output_dir))


def load_index(output_dir: Path) -> dict[str, Any]:
    index_path = output_dir / "manifest_index.json"
    if not index_path.is_file():
        raise SystemExit(f"manifest 索引不存在: {index_path}")
    return json.loads(index_path.read_text(encoding="utf-8"))


def selected_targets(index: dict[str, Any], only: list[str]) -> list[dict[str, Any]]:
    targets = index.get("targets") or []
    if not only:
        return targets
    expected = set(only)
    selected = [target for target in targets if target.get("name") in expected]
    missing = sorted(expected - {target.get("name") for target in selected})
    if missing:
        raise SystemExit(f"未找到目标: {', '.join(missing)}")
    return selected


def run_local_ingest(
    args: argparse.Namespace,
    targets: list[dict[str, Any]],
    dry_run: bool,
) -> None:
    if not dry_run:
        ensure_chroma_available(args.chroma_url)
    reports_dir = Path(args.output_dir) / "reports"
    reports_dir.mkdir(parents=True, exist_ok=True)

    for target in targets:
        manifest_path = target["manifest_path"]
        report_name = f"{target['name']}.{'dry_run' if dry_run else 'local_import'}.report.json"
        report_path = reports_dir / report_name
        cmd = [
            args.python,
            str(INGEST_SCRIPT),
            "--manifest",
            manifest_path,
            "--chroma-url",
            args.chroma_url,
            "--hermes-api",
            args.hermes_api,
            "--project-id",
            args.project_id,
            "--batch-chunk-size",
            str(args.batch_chunk_size),
            "--output",
            str(report_path),
        ]
        if args.strict_domain:
            cmd.append("--strict-domain")
        if dry_run:
            cmd.append("--dry-run")
        else:
            cmd.append("--sync-cache")
        run_command(cmd)


def ensure_chroma_available(chroma_url: str) -> None:
    heartbeat_url = f"{chroma_url.rstrip('/')}/api/v1/heartbeat"
    try:
        response = httpx.get(heartbeat_url, timeout=5.0)
    except httpx.HTTPError as exc:
        raise SystemExit(f"Chroma 不可达: {heartbeat_url} ({exc})") from exc
    if response.status_code != 200:
        preview = response.text[:200].strip()
        raise SystemExit(
            f"Chroma 心跳失败: {heartbeat_url} -> HTTP {response.status_code}"
            + (f" | {preview}" if preview else "")
        )


def upload_manifest_to_cloud(
    client: httpx.Client,
    api_base: str,
    target: dict[str, Any],
    *,
    cloud_project_id: str,
    cloud_chroma_url: str | None,
    upload_only: bool,
) -> dict[str, Any]:
    manifest_path = Path(target["manifest_path"])
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    upload_ids: list[str] = []
    upload_doc_ids: dict[str, str] = {}

    for document in manifest.get("documents", []):
        file_path = Path(document["file_path"])
        with file_path.open("rb") as handle:
            response = client.post(
                f"{api_base.rstrip('/')}/api/v1/kb/upload",
                files={"file": (file_path.name, handle, "text/markdown")},
                data={"doc_id": document["doc_id"]},
            )
        response.raise_for_status()
        body = response.json()
        upload_id = body["upload_id"]
        upload_ids.append(upload_id)
        upload_doc_ids[upload_id] = document["doc_id"]

    if upload_only:
        return {
            "target": target["name"],
            "collection": manifest["collection"],
            "uploaded": len(upload_ids),
            "upload_ids": upload_ids,
            "upload_doc_ids": upload_doc_ids,
        }

    ingest_body: dict[str, Any] = {
        "source_type": "upload",
        "collection": manifest["collection"],
        "project_id": cloud_project_id,
        "sync_cache": True,
        "upload_ids": upload_ids,
        "upload_doc_ids": upload_doc_ids,
        "defaults": manifest.get("defaults", {}),
        "batch_chunk_size": 64,
    }
    if cloud_chroma_url:
        ingest_body["chroma_url"] = cloud_chroma_url

    ingest_response = client.post(f"{api_base.rstrip('/')}/api/v1/kb/ingest", json=ingest_body)
    ingest_response.raise_for_status()
    return ingest_response.json()


def ingest_existing_cloud_upload(
    client: httpx.Client,
    api_base: str,
    target: dict[str, Any],
    *,
    cloud_project_id: str,
    cloud_chroma_url: str | None,
) -> dict[str, Any]:
    reports_dir = Path(target["manifest_path"]).parent / "reports"
    upload_report_path = reports_dir / f"{target['name']}.cloud_upload.report.json"
    if not upload_report_path.is_file():
        raise FileNotFoundError(f"未找到 cloud upload 报告: {upload_report_path}")

    cloud_report = json.loads(upload_report_path.read_text(encoding="utf-8"))
    manifest = json.loads(Path(target["manifest_path"]).read_text(encoding="utf-8"))
    doc_by_id = {str(doc["doc_id"]): doc for doc in manifest.get("documents", [])}
    manifest_defaults = dict(manifest.get("defaults") or {})

    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    for upload_id, doc_id in (cloud_report.get("upload_doc_ids") or {}).items():
        doc = doc_by_id.get(str(doc_id), {})
        domain = str(doc.get("domain") or manifest_defaults.get("domain") or "").strip()
        folder_path = str(doc.get("folder_path") or manifest_defaults.get("folder_path") or "").strip()
        key = (domain, folder_path)
        bucket = grouped.setdefault(
            key,
            {
                "upload_ids": [],
                "upload_doc_ids": {},
                "defaults": {
                    "domain": domain,
                    "folder_path": folder_path,
                    "published": doc.get("published", manifest_defaults.get("published", True)),
                    "source": doc.get("source", manifest_defaults.get("source", "obsidian_import")),
                    "source_type": doc.get("source_type", manifest_defaults.get("source_type", "file")),
                    "language": doc.get("language", manifest_defaults.get("language", "zh")),
                    "tags": doc.get("tags", manifest_defaults.get("tags", [])),
                },
            },
        )
        bucket["upload_ids"].append(upload_id)
        bucket["upload_doc_ids"][upload_id] = doc_id

    jobs: list[dict[str, Any]] = []
    for (domain, folder_path), bucket in grouped.items():
        ingest_body: dict[str, Any] = {
            "source_type": "upload",
            "collection": cloud_report["collection"],
            "project_id": cloud_project_id,
            "upload_ids": bucket["upload_ids"],
            "upload_doc_ids": bucket["upload_doc_ids"],
            "defaults": bucket["defaults"],
        }
        if cloud_chroma_url:
            ingest_body["chroma_url"] = cloud_chroma_url

        ingest_response = client.post(f"{api_base.rstrip('/')}/api/v1/kb/ingest", json=ingest_body)
        ingest_response.raise_for_status()
        job_result = ingest_response.json()
        jobs.append(
            {
                "domain": domain,
                "folder_path": folder_path,
                "doc_count": len(bucket["upload_ids"]),
                "result": job_result,
            }
        )

    succeeded = 0
    failed = 0
    chunk_total = 0
    chunk_upserted = 0
    chunk_skipped = 0
    cache_sync_triggered = False
    errors: list[dict[str, Any]] = []
    for job in jobs:
        result = job["result"]
        succeeded += int(result.get("doc_succeeded") or 0)
        failed += int(result.get("doc_failed") or 0)
        chunk_total += int(result.get("chunk_total") or 0)
        chunk_upserted += int(result.get("chunk_upserted") or 0)
        chunk_skipped += int(result.get("chunk_skipped") or 0)
        cache_sync_triggered = cache_sync_triggered or bool(result.get("cache_sync_triggered"))
        for err in result.get("errors") or []:
            errors.append(err)

    status = "completed"
    if any((job["result"].get("status") != "completed") for job in jobs):
        status = "failed"

    return {
        "target": target["name"],
        "collection": cloud_report["collection"],
        "status": status,
        "group_count": len(jobs),
        "doc_total": len(cloud_report.get("upload_ids") or []),
        "doc_succeeded": succeeded,
        "doc_failed": failed,
        "chunk_total": chunk_total,
        "chunk_upserted": chunk_upserted,
        "chunk_skipped": chunk_skipped,
        "cache_sync_triggered": cache_sync_triggered,
        "errors": errors,
        "jobs": jobs,
    }


def run_cloud_import(args: argparse.Namespace, targets: list[dict[str, Any]], *, upload_only: bool) -> None:
    if not args.cloud_api_base:
        raise SystemExit("执行 cloud-upload/cloud-import 需要传入 --cloud-api-base")

    reports_dir = Path(args.output_dir) / "reports"
    reports_dir.mkdir(parents=True, exist_ok=True)
    headers = {"X-API-Key": args.cloud_api_key} if args.cloud_api_key else {}
    with httpx.Client(timeout=300.0, headers=headers) as client:
        for target in targets:
            report = upload_manifest_to_cloud(
                client,
                args.cloud_api_base,
                target,
                cloud_project_id=args.cloud_project_id,
                cloud_chroma_url=args.cloud_chroma_url,
                upload_only=upload_only,
            )
            suffix = "cloud_upload" if upload_only else "cloud_import"
            report_path = reports_dir / f"{target['name']}.{suffix}.report.json"
            report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps({"target": target["name"], "cloud_report": report}, ensure_ascii=False, indent=2))


def run_cloud_ingest_only(args: argparse.Namespace, targets: list[dict[str, Any]]) -> None:
    if not args.cloud_api_base:
        raise SystemExit("执行 cloud-ingest-only 需要传入 --cloud-api-base")

    reports_dir = Path(args.output_dir) / "reports"
    reports_dir.mkdir(parents=True, exist_ok=True)
    headers = {"X-API-Key": args.cloud_api_key} if args.cloud_api_key else {}
    with httpx.Client(timeout=300.0, headers=headers) as client:
        for target in targets:
            report = ingest_existing_cloud_upload(
                client,
                args.cloud_api_base,
                target,
                cloud_project_id=args.cloud_project_id,
                cloud_chroma_url=args.cloud_chroma_url,
            )
            report_path = reports_dir / f"{target['name']}.cloud_ingest_only.report.json"
            report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps({"target": target["name"], "cloud_report": report}, ensure_ascii=False, indent=2))


def main() -> int:
    args = parse_args()
    steps = normalize_steps(args.steps)
    output_dir = Path(args.output_dir).expanduser().resolve()

    if "build" in steps:
        index = build_manifests(args)
    else:
        index = load_index(output_dir)

    targets = selected_targets(index, args.only)

    if "dry-run" in steps:
        run_local_ingest(args, targets, dry_run=True)
    if "local-import" in steps:
        run_local_ingest(args, targets, dry_run=False)
    if "cloud-upload" in steps:
        run_cloud_import(args, targets, upload_only=True)
    if "cloud-ingest-only" in steps:
        run_cloud_ingest_only(args, targets)
    if "cloud-import" in steps:
        run_cloud_import(args, targets, upload_only=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
