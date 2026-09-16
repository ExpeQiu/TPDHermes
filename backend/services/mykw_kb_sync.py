"""
myKW（Obsidian 4.Knowledge）与 TPDHermes 向量库的双向同步契约。

仅手动触发（CLI / 脚本），不做后台轮询。
- push：默认关闭。内部知识改由 GeelyWiki pages.json 入库；需显式 --force-push 或 MYKW_PUSH_ENABLED=1。
- pull：Hermes 自产条目 → vault `02-知识库/从Hermes回写/`
不互写：竞品 collection、project.*.kb、Wiki 冻结快照。
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import unicodedata
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from backend.services.chroma_client import ChromaHttpClient, flatten_chroma_get_ids
from backend.services.kb_ingest_core import new_ingest_job_id, run_kb_ingestion, sha256_file
from backend.services.kb_vault_assets import get_obsidian_vault_root

logger = logging.getLogger("tpdx.hermes.mykw_sync")

DEFAULT_VAULT_ROOT = Path(
    "/Users/expeqiu/Library/Mobile Documents/iCloud~md~obsidian/Documents/expe/myKW/4.Knowledge"
)
PULL_ROOT = "02-知识库/从Hermes回写"
VAULT_LOG_DIR = "00-Guide指导/_logs"

# Hermes 侧产生、允许回写 vault 的来源（Obsidian 导入的不回写，避免覆盖真源）
HERMES_OWNED_SOURCES = frozenset(
    {
        "conversation_harvest",
        "hermes_chat",
        "manual_upload",
        "manual_entry",
        "manual_import",
        "manual",
    }
)
HERMES_OWNED_SOURCE_TYPES = frozenset(
    {
        "conversation_harvest",
        "manual",
        "manual_upload",
        "manual_entry",
    }
)

# 禁止 pull/push 的 collection 前缀
BLOCKED_COLLECTION_PREFIXES = ("project.",)
BLOCKED_COLLECTIONS = frozenset(
    {
        "public.structured_tech.geely_tech",  # 互联网补充，不是 myKW 真源
        "internal.structured_tech.smoke",
        "public.structured_tech.remote_debug",
    }
)


@dataclass(frozen=True)
class ImportTarget:
    name: str
    relative_dir: str
    collection: str
    domain: str
    tags: list[str]
    published: bool = True
    language: str = "zh"
    source: str = "obsidian_import"
    source_type: str = "file"
    include_files: tuple[str, ...] = ()
    exclude_files: tuple[str, ...] = ()
    title_overrides: dict[str, str] | None = None


# 三库边界后的 push 目录（缺目录则跳过，不整批失败）
TARGETS: tuple[ImportTarget, ...] = (
    ImportTarget(
        name="jlgf_tech_points",
        relative_dir="02-知识库/吉利技术知识库",
        collection="internal.structured_tech.tech_points",
        domain="structured_tech",
        tags=["内部知识库", "技术点", "JLGF"],
        title_overrides={"JLGF.md": "吉利核心技术信息参考（JLGF）"},
    ),
    ImportTarget(
        name="vehicle_archives",
        relative_dir="02-知识库/吉利技术档案",
        collection="internal.structured_tech.tech_points",
        domain="structured_tech",
        tags=["内部知识库", "技术档案"],
    ),
    ImportTarget(
        name="release_speeches",
        relative_dir="03-发布成果",
        collection="public.release_assets.speeches",
        domain="release_assets",
        tags=["发布成果", "发言稿"],
    ),
    ImportTarget(
        name="geely_strategy",
        relative_dir="04-车企战略",
        collection="internal.internal_methodology.geely_strategy",
        domain="internal_methodology",
        tags=["吉利战略"],
    ),
)

PUSH_COLLECTIONS: frozenset[str] = frozenset(t.collection for t in TARGETS)
MYKW_PUSH_REFUSED_REASON = "mykw_push_disabled"


def mykw_push_enabled() -> bool:
    raw = os.getenv("MYKW_PUSH_ENABLED", "").strip().lower()
    return raw in ("1", "true", "yes", "on")


def resolve_vault_root(explicit: str | None = None) -> Path:
    if explicit:
        root = Path(explicit).expanduser().resolve()
    else:
        env_root = get_obsidian_vault_root()
        root = env_root if env_root is not None else DEFAULT_VAULT_ROOT
    return root


def slugify_ascii(text: str) -> str:
    normalized = unicodedata.normalize("NFKD", text)
    ascii_text = normalized.encode("ascii", "ignore").decode("ascii")
    cleaned = re.sub(r"[^A-Za-z0-9]+", "_", ascii_text).strip("_").lower()
    return cleaned or "doc"


def stable_doc_id(target_name: str, relative_path: Path) -> str:
    digest = hashlib.sha1(relative_path.as_posix().encode("utf-8")).hexdigest()[:12]
    stem_slug = slugify_ascii(relative_path.stem)[:32]
    return f"obs_{target_name}_{stem_slug}_{digest}"


def extract_title(path: Path) -> str:
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for _ in range(120):
                line = handle.readline()
                if not line:
                    break
                stripped = line.strip()
                if stripped.startswith("#"):
                    heading = stripped.lstrip("#").strip()
                    if heading:
                        return heading
    except OSError:
        pass
    return path.stem


def derive_tags(target: ImportTarget, relative_file: Path) -> list[str]:
    derived = list(target.tags)
    for part in relative_file.parent.parts:
        part = part.strip()
        if not part or part == ".":
            continue
        if part not in derived:
            derived.append(part)
    return derived


def build_document_entry(
    vault_root: Path,
    target: ImportTarget,
    source_root: Path,
    file_path: Path,
) -> dict[str, Any]:
    relative_to_target = file_path.relative_to(source_root)
    relative_to_vault = file_path.relative_to(vault_root)
    folder_base = Path(target.relative_dir)
    parent = relative_to_target.parent
    if str(parent) == ".":
        folder_path = folder_base.as_posix()
    else:
        folder_path = (folder_base / parent).as_posix()
    entry: dict[str, Any] = {
        "doc_id": stable_doc_id(target.name, relative_to_vault),
        "file_path": str(file_path),
        "title": extract_title(file_path),
        "folder_path": folder_path,
        "tags": derive_tags(target, relative_to_target),
        "source_url": "",
        "checksum": sha256_file(file_path),
    }
    overrides = target.title_overrides or {}
    override_title = overrides.get(relative_to_target.as_posix()) or overrides.get(file_path.name)
    if override_title:
        entry["title"] = override_title
    return entry


def list_target_documents(vault_root: Path, target: ImportTarget) -> list[dict[str, Any]]:
    source_root = vault_root / target.relative_dir
    if not source_root.is_dir():
        return []
    if target.include_files:
        documents = []
        for rel_name in target.include_files:
            file_path = source_root / rel_name
            if file_path.is_file():
                documents.append(build_document_entry(vault_root, target, source_root, file_path))
        return documents
    excluded = set(target.exclude_files)
    return [
        build_document_entry(vault_root, target, source_root, path)
        for path in sorted(source_root.rglob("*.md"))
        if path.is_file() and path.relative_to(source_root).as_posix() not in excluded
    ]


def build_manifest(
    vault_root: Path,
    output_dir: Path,
    batch_prefix: str,
    target: ImportTarget,
    *,
    skip_missing: bool = False,
) -> dict[str, Any] | None:
    source_root = vault_root / target.relative_dir
    if not source_root.is_dir():
        if skip_missing:
            logger.warning("sync skip missing dir target=%s path=%s", target.name, source_root)
            return None
        raise FileNotFoundError(f"目录不存在: {source_root}")

    documents = list_target_documents(vault_root, target)
    if not documents:
        if skip_missing:
            logger.warning("sync skip empty target=%s path=%s", target.name, source_root)
            return None
        raise ValueError(f"目录下未找到 Markdown 文件: {source_root}")

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    batch_id = f"{batch_prefix}_{target.name}_{timestamp}"
    manifest = {
        "batch_id": batch_id,
        "collection": target.collection,
        "defaults": {
            "domain": target.domain,
            "folder_path": target.relative_dir,
            "published": target.published,
            "source": target.source,
            "source_type": target.source_type,
            "language": target.language,
            "tags": target.tags,
        },
        "documents": documents,
    }
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{target.name}.manifest.json"
    output_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "name": target.name,
        "collection": target.collection,
        "document_count": len(documents),
        "source_root": str(source_root),
        "manifest_path": str(output_path),
        "config": asdict(target),
    }


def collection_allowed(name: str) -> bool:
    key = (name or "").strip()
    if not key:
        return False
    if key in BLOCKED_COLLECTIONS:
        return False
    return not any(key.startswith(p) for p in BLOCKED_COLLECTION_PREFIXES)


def is_hermes_owned(meta: dict[str, Any]) -> bool:
    source = str(meta.get("source") or "").strip()
    source_type = str(meta.get("source_type") or "").strip()
    if source in {"obsidian_import", "web_retrieval"}:
        return False
    if source_type in {"file", "web"} and source == "obsidian_import":
        return False
    return source in HERMES_OWNED_SOURCES or source_type in HERMES_OWNED_SOURCE_TYPES


def _flatten_metas(data: dict[str, Any]) -> list[dict[str, Any]]:
    metas = data.get("metadatas") or []
    if metas and isinstance(metas[0], list):
        return [m if isinstance(m, dict) else {} for m in metas[0]]
    if isinstance(metas, list):
        return [m if isinstance(m, dict) else {} for m in metas]
    return []


def _flatten_docs(data: dict[str, Any]) -> list[str]:
    docs = data.get("documents") or []
    if docs and isinstance(docs[0], list):
        return [str(d) if d is not None else "" for d in docs[0]]
    if isinstance(docs, list):
        return [str(d) if d is not None else "" for d in docs]
    return []


def dump_collection(client: ChromaHttpClient, collection: str) -> dict[str, Any]:
    return client.get_by_where(
        collection,
        {},
        limit=100_000,
        include=["metadatas", "documents"],
    )


def group_chunks_by_doc(
    data: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    ids = flatten_chroma_get_ids(data)
    metas = _flatten_metas(data)
    docs = _flatten_docs(data)
    grouped: dict[str, dict[str, Any]] = {}
    for i, chunk_id in enumerate(ids):
        meta = metas[i] if i < len(metas) else {}
        text = docs[i] if i < len(docs) else ""
        doc_id = str(meta.get("doc_id") or "").strip()
        if not doc_id:
            continue
        bucket = grouped.setdefault(
            doc_id,
            {"doc_id": doc_id, "chunks": [], "meta": meta},
        )
        try:
            idx = int(meta.get("chunk_index") or 0)
        except (TypeError, ValueError):
            idx = 0
        bucket["chunks"].append((idx, text, meta))
        if not bucket.get("meta"):
            bucket["meta"] = meta
    for bucket in grouped.values():
        bucket["chunks"].sort(key=lambda x: x[0])
    return grouped


def reconstruct_markdown(chunks: list[tuple[int, str, dict[str, Any]]]) -> str:
    parts = [str(text or "").strip() for _, text, _ in chunks if str(text or "").strip()]
    return "\n\n".join(parts).strip() + ("\n" if parts else "")


def pull_dest_path(vault_root: Path, collection: str, doc_id: str) -> Path:
    safe_col = re.sub(r"[^A-Za-z0-9._-]+", "_", collection).strip("_") or "unknown"
    safe_id = re.sub(r"[^A-Za-z0-9._-]+", "_", doc_id).strip("_") or "doc"
    return vault_root / PULL_ROOT / safe_col / f"{safe_id}.md"


def render_pulled_note(
    *,
    doc_id: str,
    collection: str,
    body: str,
    meta: dict[str, Any],
    checksum: str,
    synced_at: str,
) -> str:
    title = str(meta.get("title") or doc_id).strip()
    fm = {
        "hermes_sync": "pull",
        "hermes_doc_id": doc_id,
        "hermes_collection": collection,
        "hermes_source": str(meta.get("source") or ""),
        "hermes_source_type": str(meta.get("source_type") or ""),
        "title": title,
        "checksum": checksum,
        "synced_at": synced_at,
    }
    lines = ["---"]
    for k, v in fm.items():
        lines.append(f"{k}: {json.dumps(v, ensure_ascii=False)}")
    lines.append("---")
    lines.append("")
    if not body.lstrip().startswith("#"):
        lines.append(f"# {title}")
        lines.append("")
    lines.append(body.rstrip())
    lines.append("")
    return "\n".join(lines)


_FM_CHECKSUM = re.compile(r'^checksum:\s*(.+)$', re.MULTILINE)


def read_note_checksum(path: Path) -> str:
    """读取 pull 笔记 frontmatter 里的 checksum，避免整文件 hash 与 chunk checksum 对不上。"""
    if not path.is_file():
        return ""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")[:4000]
    except OSError:
        return ""
    m = _FM_CHECKSUM.search(text)
    if not m:
        return ""
    raw = m.group(1).strip().strip(",")
    try:
        parsed = json.loads(raw)
        return str(parsed)
    except json.JSONDecodeError:
        return raw.strip('"')


def chroma_doc_checksum(grouped_doc: dict[str, Any]) -> str:
    meta = grouped_doc.get("meta") or {}
    raw = str(meta.get("checksum") or "").strip()
    if raw:
        return raw
    body = reconstruct_markdown(grouped_doc.get("chunks") or [])
    digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def status_report(
    vault_root: Path,
    *,
    chroma_url: str | None = None,
    only: Optional[list[str]] = None,
) -> dict[str, Any]:
    run_id = new_ingest_job_id().replace("ing_", "sync_", 1)
    targets = [t for t in TARGETS if not only or t.name in only]
    push_side: list[dict[str, Any]] = []
    for target in targets:
        docs = list_target_documents(vault_root, target)
        push_side.append(
            {
                "name": target.name,
                "collection": target.collection,
                "dir": target.relative_dir,
                "dir_exists": (vault_root / target.relative_dir).is_dir(),
                "md_count": len(docs),
            }
        )

    pull_side: dict[str, Any] = {
        "chroma_reachable": False,
        "hermes_owned_docs": 0,
        "already_on_disk": 0,
        "pending_pull": 0,
        "blocked": 0,
        "collections": [],
    }
    if chroma_url:
        client = ChromaHttpClient(chroma_url)
        pull_side["chroma_reachable"] = client.heartbeat()
        if pull_side["chroma_reachable"]:
            names = [n for n in client.collection_names() if collection_allowed(n)]
            scan = set(PUSH_COLLECTIONS) | set(names)
            for col in sorted(scan):
                if not collection_allowed(col):
                    pull_side["blocked"] += 1
                    continue
                try:
                    data = dump_collection(client, col)
                except Exception as exc:
                    logger.warning("sync status dump failed collection=%s err=%s", col, exc)
                    continue
                grouped = group_chunks_by_doc(data)
                owned = [g for g in grouped.values() if is_hermes_owned(g.get("meta") or {})]
                on_disk = 0
                for g in owned:
                    dest = pull_dest_path(vault_root, col, str(g["doc_id"]))
                    if dest.is_file():
                        on_disk += 1
                pull_side["hermes_owned_docs"] += len(owned)
                pull_side["already_on_disk"] += on_disk
                pull_side["pending_pull"] += len(owned) - on_disk
                pull_side["collections"].append(
                    {"collection": col, "owned": len(owned), "on_disk": on_disk}
                )

    report = {
        "run_id": run_id,
        "direction": "status",
        "vault_root": str(vault_root),
        "push": push_side,
        "pull": pull_side,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    logger.info(
        "mykw sync status run_id=%s push_targets=%s pending_pull=%s",
        run_id,
        len(push_side),
        pull_side["pending_pull"],
    )
    return report


def push_to_hermes(
    vault_root: Path,
    *,
    chroma_url: str,
    output_dir: Path,
    apply: bool,
    only: Optional[list[str]] = None,
    sync_cache: bool = False,
    hermes_api: str = "http://localhost:8000",
    project_id: str = "__all__",
    batch_chunk_size: int = 64,
    allow_push: bool = False,
) -> dict[str, Any]:
    run_id = new_ingest_job_id().replace("ing_", "sync_", 1)
    if apply and not allow_push:
        logger.warning(
            "mykw sync push refused run_id=%s reason=%s",
            run_id,
            MYKW_PUSH_REFUSED_REASON,
        )
        return {
            "run_id": run_id,
            "direction": "push",
            "apply": apply,
            "ok": False,
            "refused": True,
            "reason": MYKW_PUSH_REFUSED_REASON,
            "message": (
                "内部知识已改由 GeelyWiki pages.json 入库。"
                "需要直推请加 --force-push 或设置 MYKW_PUSH_ENABLED=1。"
            ),
            "vault_root": str(vault_root),
            "targets": [],
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
    targets = [t for t in TARGETS if not only or t.name in only]
    reports: list[dict[str, Any]] = []
    for target in targets:
        if not collection_allowed(target.collection):
            reports.append({"name": target.name, "skipped": True, "reason": "blocked_collection"})
            continue
        summary = build_manifest(
            vault_root,
            output_dir,
            "mykw_push",
            target,
            skip_missing=True,
        )
        if not summary:
            reports.append({"name": target.name, "skipped": True, "reason": "missing_or_empty"})
            continue
        manifest = json.loads(Path(summary["manifest_path"]).read_text(encoding="utf-8"))
        ingest = run_kb_ingestion(
            manifest=manifest,
            collection=target.collection,
            chroma_url=chroma_url,
            job_id=run_id,
            dry_run=not apply,
            batch_chunk_size=batch_chunk_size,
        )
        reports.append({"name": target.name, "summary": summary, "ingest": ingest})

    if apply and sync_cache:
        from backend.services.kb_ingest_core import trigger_cache_sync_http

        cols = sorted({t.collection for t in targets if collection_allowed(t.collection)})
        ok, err = trigger_cache_sync_http(hermes_api, project_id, chroma_url, cols)
        cache = {"ok": ok, "error": err}
    else:
        cache = {"ok": False, "skipped": True}

    result = {
        "run_id": run_id,
        "direction": "push",
        "apply": apply,
        "vault_root": str(vault_root),
        "targets": reports,
        "cache_sync": cache,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    logger.info("mykw sync push run_id=%s apply=%s targets=%s", run_id, apply, len(reports))
    return result


def pull_from_hermes(
    vault_root: Path,
    *,
    chroma_url: str,
    apply: bool,
    overwrite: bool = False,
    only_collections: Optional[list[str]] = None,
) -> dict[str, Any]:
    run_id = new_ingest_job_id().replace("ing_", "sync_", 1)
    synced_at = datetime.now(timezone.utc).isoformat()
    client = ChromaHttpClient(chroma_url)
    if not client.heartbeat():
        return {
            "run_id": run_id,
            "direction": "pull",
            "ok": False,
            "message": "chroma_unreachable",
            "apply": apply,
        }

    names = client.collection_names()
    scan = [n for n in names if collection_allowed(n)]
    if only_collections:
        allow = set(only_collections)
        scan = [n for n in scan if n in allow]
    else:
        # 默认只扫映射 collection，避免把互联网/杂集合拉进 myKW
        scan = [n for n in scan if n in PUSH_COLLECTIONS]

    written: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    pending: list[dict[str, Any]] = []

    for col in scan:
        try:
            data = dump_collection(client, col)
        except Exception as exc:
            logger.warning("sync pull dump failed collection=%s err=%s", col, exc)
            skipped.append({"collection": col, "reason": f"dump_failed:{exc}"})
            continue
        grouped = group_chunks_by_doc(data)
        for doc_id, payload in grouped.items():
            meta = payload.get("meta") or {}
            if not is_hermes_owned(meta):
                skipped.append({"doc_id": doc_id, "collection": col, "reason": "not_hermes_owned"})
                continue
            body = reconstruct_markdown(payload.get("chunks") or [])
            checksum = chroma_doc_checksum(payload)
            dest = pull_dest_path(vault_root, col, doc_id)
            if dest.is_file() and not overwrite:
                existing = read_note_checksum(dest)
                if existing == checksum:
                    skipped.append({"doc_id": doc_id, "reason": "unchanged", "path": str(dest)})
                    continue
                skipped.append({"doc_id": doc_id, "reason": "exists_different_checksum", "path": str(dest)})
                continue
            note = render_pulled_note(
                doc_id=doc_id,
                collection=col,
                body=body,
                meta=meta,
                checksum=checksum,
                synced_at=synced_at,
            )
            item = {"doc_id": doc_id, "collection": col, "path": str(dest), "checksum": checksum}
            if apply:
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_text(note, encoding="utf-8")
                written.append(item)
            else:
                pending.append(item)

    result = {
        "run_id": run_id,
        "direction": "pull",
        "ok": True,
        "apply": apply,
        "overwrite": overwrite,
        "vault_root": str(vault_root),
        "pull_root": PULL_ROOT,
        "written": written,
        "pending": pending,
        "skipped_count": len(skipped),
        "skipped_sample": skipped[:30],
        "generated_at": synced_at,
    }
    logger.info(
        "mykw sync pull run_id=%s apply=%s written=%s pending=%s skipped=%s",
        run_id,
        apply,
        len(written),
        len(pending),
        len(skipped),
    )
    return result


def write_json_log(report: dict[str, Any], log_dir: Path) -> Path:
    log_dir.mkdir(parents=True, exist_ok=True)
    run_id = str(report.get("run_id") or "sync")
    path = log_dir / f"{run_id}.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def write_vault_log(vault_root: Path, report: dict[str, Any]) -> Path | None:
    if not report.get("apply"):
        return None
    log_dir = vault_root / VAULT_LOG_DIR
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        return None
    day = datetime.now().strftime("%Y%m%d")
    path = log_dir / f"{day}-mykw-hermes-sync.md"
    line = (
        f"- {report.get('generated_at')} `{report.get('direction')}` "
        f"run_id={report.get('run_id')} apply={report.get('apply')}\n"
    )
    if path.exists():
        path.write_text(path.read_text(encoding="utf-8") + line, encoding="utf-8")
    else:
        path.write_text(
            f"# myKW ↔ TPDHermes 同步日志\n\n{line}",
            encoding="utf-8",
        )
    return path
