"""知识库 / 业务域 / 目录路径的查询与增删改。"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from typing import Any

from sqlalchemy import select

from backend.db import async_session_maker, engine
from backend.models.kb_cache import KBCache
from backend.models.kb_catalog import KbCatalogItem
from backend.services.kb_contract import KB_DOMAIN_ENUM
from backend.services.kb_entry_manage import create_kb_manual_entry, delete_kb_entry, update_kb_entry
from backend.services.kb_ids import kb_doc_id_from_ref

log = logging.getLogger("tpdx.hermes")

BUILTIN_SCOPES: tuple[dict[str, str], ...] = (
    {"key": "internal", "label": "内部知识库"},
    {"key": "public", "label": "公共知识库"},
    {"key": "project", "label": "项目知识库"},
)

BUILTIN_DOMAIN_LABELS: dict[str, str] = {
    "public_intel": "公开情报",
    "structured_tech": "结构化技术",
    "release_assets": "发布素材",
    "market_research": "市场研究",
    "policy_regulation": "政策法规",
    "internal_methodology": "内部方法论",
    "brand_map": "品牌地图",
    "methodology": "方法论",
}

_DOMAIN_KEY = re.compile(r"^[a-z][a-z0-9_]{1,48}$")
_ready = False


def _now() -> str:
    return datetime.now().isoformat()


def _item_id(kind: str, key: str) -> str:
    return f"{kind}:{key}"


def normalize_folder_path(raw: str) -> str:
    text = (raw or "").strip().strip("/")
    parts = [part.strip() for part in text.split("/") if part.strip() and part.strip() != "."]
    if not parts or any(part == ".." for part in parts):
        return ""
    return "/".join(parts)


def _scope_of_collection(name: str) -> str:
    key = (name or "").strip()
    if key.startswith("project."):
        return "project"
    if key.startswith("internal."):
        return "internal"
    if key.startswith("public."):
        return "public"
    return ""


def _domain_of_collection(name: str) -> str:
    parts = [part for part in (name or "").split(".") if part]
    if len(parts) >= 2 and parts[0] in {"internal", "public"}:
        return parts[1]
    return ""


def _meta(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _folder_matches(folder: str, prefix: str) -> bool:
    return folder == prefix or folder.startswith(prefix + "/")


def _rewrite_folder(folder: str, old: str, new: str) -> str:
    if folder == old:
        return new
    if folder.startswith(old + "/"):
        return new + folder[len(old) :]
    return folder


def _is_index_doc(doc_id: str, meta: dict[str, Any]) -> bool:
    if doc_id.startswith("pathcat_") or doc_id.startswith("colcat_"):
        return True
    if str(meta.get("source_type") or "") == "catalog_index":
        return True
    title = str(meta.get("title") or "")
    return "分类索引" in title


async def ensure_catalog_table() -> None:
    global _ready
    if _ready:
        return
    async with engine.begin() as conn:
        await conn.run_sync(KbCatalogItem.__table__.create, checkfirst=True)
    _ready = True
    log.info("kb catalog table ready")


async def _rows(kind: str | None = None) -> list[KbCatalogItem]:
    await ensure_catalog_table()
    async with async_session_maker() as db:
        query = select(KbCatalogItem)
        if kind:
            query = query.where(KbCatalogItem.kind == kind)
        result = await db.execute(query)
        return list(result.scalars().all())


async def _usage() -> dict[str, Any]:
    domain_docs: dict[str, set[str]] = {}
    folder_docs: dict[str, set[str]] = {}
    folder_domain: dict[str, str] = {}
    folder_scope: dict[str, str] = {}
    domain_collections: dict[str, set[str]] = {}
    docs: list[dict[str, str]] = []
    async with async_session_maker() as db:
        result = await db.execute(select(KBCache.id, KBCache.collection, KBCache.metadata_).limit(8000))
        cached = result.all()
    for row_id, collection, raw_meta in cached:
        meta = _meta(raw_meta)
        domain = str(meta.get("domain") or "").strip()
        folder = str(meta.get("folder_path") or "").strip().strip("/")
        col = str(collection or "")
        doc_id = str(meta.get("doc_id") or "").strip() or kb_doc_id_from_ref(str(row_id))
        if domain and domain != "_uncategorized":
            domain_docs.setdefault(domain, set()).add(doc_id or str(row_id))
            domain_collections.setdefault(domain, set()).add(col)
        name_domain = _domain_of_collection(col)
        if name_domain:
            domain_collections.setdefault(name_domain, set()).add(col)
        if folder:
            folder_docs.setdefault(folder, set()).add(doc_id or str(row_id))
            if domain and folder not in folder_domain:
                folder_domain[folder] = domain
            scope = _scope_of_collection(col)
            if scope and folder not in folder_scope:
                folder_scope[folder] = scope
        if doc_id:
            docs.append(
                {
                    "id": str(row_id),
                    "doc_id": doc_id,
                    "collection": col,
                    "folder": folder,
                    "domain": domain,
                    "title": str(meta.get("title") or ""),
                    "source_type": str(meta.get("source_type") or ""),
                }
            )
    return {
        "domain_docs": domain_docs,
        "folder_docs": folder_docs,
        "folder_domain": folder_domain,
        "folder_scope": folder_scope,
        "domain_collections": domain_collections,
        "docs": docs,
    }


async def list_catalog() -> dict[str, Any]:
    stored = await _rows()
    usage = await _usage()
    label_override = {
        row.item_key: row.label
        for row in stored
        if row.kind == "domain" and row.label
    }
    custom_domains = [row for row in stored if row.kind == "domain" and row.builtin != "1"]
    keys: list[str] = list(BUILTIN_DOMAIN_LABELS)
    for row in custom_domains:
        if row.item_key not in keys:
            keys.append(row.item_key)
    for key in usage["domain_docs"]:
        if key not in keys and key != "_uncategorized":
            keys.append(key)
    domains = []
    for key in keys:
        domains.append(
            {
                "key": key,
                "label": label_override.get(key) or BUILTIN_DOMAIN_LABELS.get(key) or key,
                "builtin": key in BUILTIN_DOMAIN_LABELS or key in KB_DOMAIN_ENUM,
                "doc_count": len(usage["domain_docs"].get(key) or ()),
                "collection_count": len(usage["domain_collections"].get(key) or ()),
            }
        )
    folder_map: dict[str, dict[str, Any]] = {}
    for row in stored:
        if row.kind != "folder":
            continue
        folder_map[row.item_key] = {
            "path": row.item_key,
            "label": row.label or row.item_key,
            "domain": row.parent_key or usage["folder_domain"].get(row.item_key) or "",
            "scope": row.scope or usage["folder_scope"].get(row.item_key) or "",
            "doc_count": len(usage["folder_docs"].get(row.item_key) or ()),
            "stored": True,
        }
    for path, count in usage["folder_docs"].items():
        current = folder_map.get(path)
        if current:
            current["doc_count"] = len(count)
            if not current["domain"]:
                current["domain"] = usage["folder_domain"].get(path) or ""
            if not current["scope"]:
                current["scope"] = usage["folder_scope"].get(path) or ""
            continue
        folder_map[path] = {
            "path": path,
            "label": path.split("/")[-1],
            "domain": usage["folder_domain"].get(path) or "",
            "scope": usage["folder_scope"].get(path) or "",
            "doc_count": len(count),
            "stored": False,
        }
    folders = sorted(folder_map.values(), key=lambda item: str(item["path"]))
    log.info("kb catalog listed domains=%s folders=%s", len(domains), len(folders))
    return {"scopes": list(BUILTIN_SCOPES), "domains": domains, "folders": folders}


async def create_domain(*, key: str, label: str) -> dict[str, Any]:
    item_key = (key or "").strip()
    name = (label or "").strip()
    if not _DOMAIN_KEY.match(item_key) or item_key in {"_uncategorized"}:
        return {"ok": False, "message": "invalid_domain_key"}
    if item_key in BUILTIN_DOMAIN_LABELS or item_key in KB_DOMAIN_ENUM:
        return {"ok": False, "message": "domain_exists"}
    if not name:
        return {"ok": False, "message": "label_required"}
    await ensure_catalog_table()
    async with async_session_maker() as db:
        existing = await db.get(KbCatalogItem, _item_id("domain", item_key))
        if existing:
            return {"ok": False, "message": "domain_exists"}
        now = _now()
        db.add(
            KbCatalogItem(
                id=_item_id("domain", item_key),
                kind="domain",
                item_key=item_key,
                label=name,
                builtin="0",
                created_at=now,
                updated_at=now,
            )
        )
        await db.commit()
    log.info("kb catalog domain created key=%s label=%s", item_key, name)
    return {"ok": True, "key": item_key, "label": name}


async def update_domain(*, key: str, label: str) -> dict[str, Any]:
    item_key = (key or "").strip()
    name = (label or "").strip()
    if not item_key or not name:
        return {"ok": False, "message": "label_required"}
    if item_key not in BUILTIN_DOMAIN_LABELS and not _DOMAIN_KEY.match(item_key):
        return {"ok": False, "message": "domain_not_found"}
    await ensure_catalog_table()
    async with async_session_maker() as db:
        row = await db.get(KbCatalogItem, _item_id("domain", item_key))
        now = _now()
        if row:
            row.label = name
            row.updated_at = now
        else:
            if item_key not in BUILTIN_DOMAIN_LABELS:
                return {"ok": False, "message": "domain_not_found"}
            db.add(
                KbCatalogItem(
                    id=_item_id("domain", item_key),
                    kind="domain",
                    item_key=item_key,
                    label=name,
                    builtin="1",
                    created_at=now,
                    updated_at=now,
                )
            )
        await db.commit()
    log.info("kb catalog domain renamed key=%s label=%s", item_key, name)
    return {"ok": True, "key": item_key, "label": name}


async def delete_domain(key: str) -> dict[str, Any]:
    item_key = (key or "").strip()
    if item_key in BUILTIN_DOMAIN_LABELS or item_key in KB_DOMAIN_ENUM:
        return {"ok": False, "message": "builtin_domain"}
    usage = await _usage()
    if usage["domain_docs"].get(item_key) or usage["domain_collections"].get(item_key):
        return {"ok": False, "message": "domain_in_use"}
    await ensure_catalog_table()
    async with async_session_maker() as db:
        row = await db.get(KbCatalogItem, _item_id("domain", item_key))
        if not row or row.kind != "domain":
            return {"ok": False, "message": "domain_not_found"}
        folder_rows = (
            await db.execute(
                select(KbCatalogItem).where(
                    KbCatalogItem.kind == "folder",
                    KbCatalogItem.parent_key == item_key,
                )
            )
        ).scalars().all()
        if folder_rows:
            return {"ok": False, "message": "domain_in_use"}
        await db.delete(row)
        await db.commit()
    log.info("kb catalog domain deleted key=%s", item_key)
    return {"ok": True, "key": item_key}


def _collection_name(scope: str, domain: str, project_id: str, collection: str) -> str:
    chosen = (collection or "").strip()
    if chosen:
        return chosen
    if scope == "project":
        return f"project.{project_id}.kb" if project_id else ""
    return f"{scope}.{domain}.general"


async def create_folder(
    *,
    path: str,
    domain: str,
    scope: str,
    project_id: str = "",
    collection: str = "",
) -> dict[str, Any]:
    folder = normalize_folder_path(path)
    dom = (domain or "").strip()
    sc = (scope or "").strip()
    if not folder:
        return {"ok": False, "message": "invalid_folder_path"}
    if sc not in {"internal", "public", "project"}:
        return {"ok": False, "message": "scope_required"}
    if sc == "project" and not (project_id or "").strip() and not (collection or "").strip():
        return {"ok": False, "message": "project_required"}
    if not dom:
        return {"ok": False, "message": "domain_required"}
    known = {item["key"] for item in (await list_catalog())["domains"]}
    if dom not in known:
        return {"ok": False, "message": "domain_not_found"}
    col = _collection_name(sc, dom, (project_id or "").strip(), collection)
    if not col:
        return {"ok": False, "message": "project_required"}
    await ensure_catalog_table()
    now = _now()
    async with async_session_maker() as db:
        row = await db.get(KbCatalogItem, _item_id("folder", folder))
        if row:
            row.parent_key = dom
            row.scope = sc
            row.label = folder.split("/")[-1]
            row.updated_at = now
        else:
            db.add(
                KbCatalogItem(
                    id=_item_id("folder", folder),
                    kind="folder",
                    item_key=folder,
                    label=folder.split("/")[-1],
                    parent_key=dom,
                    scope=sc,
                    builtin="0",
                    created_at=now,
                    updated_at=now,
                )
            )
        await db.commit()
    doc_id = "pathcat_" + re.sub(r"[^a-zA-Z0-9_]+", "_", folder)[:40]
    already = len((await _usage())["folder_docs"].get(folder) or ())
    if already:
        log.info("kb catalog folder stored path=%s domain=%s docs=%s", folder, dom, already)
        return {"ok": True, "path": folder, "domain": dom, "scope": sc, "collection": col, "index_ok": True}
    created = await create_kb_manual_entry(
        collection=col,
        title=f"{folder.split('/')[-1]}（分类索引）",
        content=f"目录 {folder} 的分类索引，用于在知识库目录中保留这个路径。",
        domain=dom,
        folder_path=folder,
        published=True,
        doc_id=doc_id,
        source_type="catalog_index",
        project_id=(project_id or "").strip() or "__all__",
        sync_cache=True,
    )
    log.info(
        "kb catalog folder created path=%s domain=%s scope=%s collection=%s index_ok=%s",
        folder,
        dom,
        sc,
        col,
        created.get("ok"),
    )
    return {
        "ok": True,
        "path": folder,
        "domain": dom,
        "scope": sc,
        "collection": col,
        "index_ok": bool(created.get("ok")),
        "index_message": created.get("message"),
    }


async def _patch_cache_folder(doc_id: str, folder: str) -> int:
    changed = 0
    async with async_session_maker() as db:
        rows = (await db.execute(select(KBCache))).scalars().all()
        now = _now()
        for row in rows:
            meta = _meta(row.metadata_)
            current_id = str(meta.get("doc_id") or "").strip() or kb_doc_id_from_ref(str(row.id))
            if current_id != doc_id:
                continue
            if str(meta.get("folder_path") or "").strip().strip("/") == folder:
                continue
            meta["folder_path"] = folder
            row.metadata_ = json.dumps(meta, ensure_ascii=False)
            row.updated_at = now
            changed += 1
        if changed:
            await db.commit()
    return changed


async def rename_folder(*, path: str, new_path: str) -> dict[str, Any]:
    old = normalize_folder_path(path)
    new = normalize_folder_path(new_path)
    if not old or not new:
        return {"ok": False, "message": "invalid_folder_path"}
    if old == new:
        return {"ok": True, "path": new, "updated_docs": 0}
    usage = await _usage()
    grouped: dict[tuple[str, str], str] = {}
    for doc in usage["docs"]:
        folder = doc["folder"]
        if not _folder_matches(folder, old):
            continue
        grouped[(doc["collection"], doc["doc_id"])] = _rewrite_folder(folder, old, new)
    updated = 0
    chroma_failed = 0
    for (collection, doc_id), folder in grouped.items():
        if not collection:
            chroma_failed += await _patch_cache_folder(doc_id, folder) or 1
            updated += 1
            continue
        result = await update_kb_entry(
            collection=collection,
            doc_id=doc_id,
            metadata={"folder_path": folder},
            sync_cache=True,
        )
        if result.get("ok"):
            updated += 1
            continue
        patched = await _patch_cache_folder(doc_id, folder)
        if patched:
            updated += 1
        else:
            chroma_failed += 1
            log.warning(
                "kb catalog folder rename missed collection=%s doc_id=%s message=%s",
                collection,
                doc_id,
                result.get("message"),
            )
    await ensure_catalog_table()
    async with async_session_maker() as db:
        rows = (await db.execute(select(KbCatalogItem).where(KbCatalogItem.kind == "folder"))).scalars().all()
        now = _now()
        for row in rows:
            if not _folder_matches(row.item_key, old):
                continue
            rewritten = _rewrite_folder(row.item_key, old, new)
            replacement = KbCatalogItem(
                id=_item_id("folder", rewritten),
                kind="folder",
                item_key=rewritten,
                label=rewritten.split("/")[-1],
                parent_key=row.parent_key,
                scope=row.scope,
                builtin="0",
                created_at=row.created_at or now,
                updated_at=now,
            )
            await db.delete(row)
            await db.merge(replacement)
        await db.commit()
    log.info(
        "kb catalog folder renamed from=%s to=%s updated_docs=%s chroma_failed=%s",
        old,
        new,
        updated,
        chroma_failed,
    )
    return {"ok": True, "path": new, "updated_docs": updated, "chroma_failed": chroma_failed}


async def delete_folder(path: str) -> dict[str, Any]:
    folder = normalize_folder_path(path)
    if not folder:
        return {"ok": False, "message": "invalid_folder_path"}
    usage = await _usage()
    matched: dict[tuple[str, str], dict[str, str]] = {}
    for doc in usage["docs"]:
        if _folder_matches(doc["folder"], folder):
            matched[(doc["collection"], doc["doc_id"])] = doc
    blocked = 0
    indexes: list[dict[str, str]] = []
    for doc in matched.values():
        if _is_index_doc(doc["doc_id"], {"title": doc["title"], "source_type": doc["source_type"]}):
            indexes.append(doc)
        else:
            blocked += 1
    if blocked:
        return {"ok": False, "message": "folder_not_empty", "doc_count": blocked}
    removed = 0
    failed = 0
    for doc in indexes:
        if not doc["collection"]:
            failed += 1
            continue
        result = await delete_kb_entry(collection=doc["collection"], doc_id=doc["doc_id"])
        if result.get("ok"):
            removed += 1
        else:
            failed += 1
    if failed:
        log.warning("kb catalog folder delete incomplete path=%s failed=%s", folder, failed)
        return {"ok": False, "message": "folder_delete_failed", "index_removed": removed}
    await ensure_catalog_table()
    async with async_session_maker() as db:
        rows = (await db.execute(select(KbCatalogItem).where(KbCatalogItem.kind == "folder"))).scalars().all()
        for row in rows:
            if _folder_matches(row.item_key, folder):
                await db.delete(row)
        await db.commit()
    log.info("kb catalog folder deleted path=%s index_removed=%s", folder, removed)
    return {"ok": True, "path": folder, "index_removed": removed}
