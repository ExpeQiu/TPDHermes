"""
知识库路由：提供 KB 健康检查、collection 查询等接口
"""

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from backend.services.kb_proxy import kb_proxy_service
from backend.services.kb_browse import DEFAULT_TREE_ENTRY_LIMIT, build_browse_tree
from backend.services.kb_cache import kb_cache_service
from backend.services.kg_service import kb_kg_link_service

router = APIRouter(prefix="/kb", tags=["knowledge_base"])
kb_route_logger = logging.getLogger("tpdx.hermes")


# --- Pydantic Schemas ---

class KBHealthResponse(BaseModel):
    external_kb: str  # "up" | "down"
    cache_mode: bool
    cached_entries: int
    readonly_mode: bool


class KBQueriesRequest(BaseModel):
    collection_name: str
    query_text: str
    n_results: int = 10
    project_id: Optional[str] = None


class KBQueriesResponse(BaseModel):
    results: list[dict]
    source: str  # "chroma" | "cache"
    count: int
    warning: Optional[str] = None


class CollectionListResponse(BaseModel):
    collections: list[str]
    source: str
    warning: Optional[str] = None


class CacheStatsResponse(BaseModel):
    project_id: str
    total_entries: int
    synced_entries: int
    collections: list[str]
    readonly_mode: bool


class SyncRequest(BaseModel):
    project_id: str
    external_kb_url: str
    collections: Optional[list[str]] = None


class SyncResponse(BaseModel):
    synced: int
    failed: int
    skipped: int
    readonly_mode: bool


class KbKgLinkCreate(BaseModel):
    kb_entry_id: str
    kb_project_id: str
    kg_kind: str
    kg_node_id: str


@router.get("/browse-tree")
async def kb_browse_tree(
    project_id: str = Query("__all__", description="__all__ 表示跨项目汇总"),
    domain: str | None = Query(None, description="仅返回该 metadata.domain"),
    collection: str | None = Query(None),
    limit: int = Query(DEFAULT_TREE_ENTRY_LIMIT, ge=1, le=8000),
):
    """从 kb_cache 聚合只读目录树（依赖 metadata.domain / folder_path）。"""
    tree = await build_browse_tree(
        project_id=project_id,
        domain_filter=domain,
        collection=collection,
        limit=limit,
    )
    return tree


@router.get("/kg-links")
async def kb_list_kg_links(
    kb_entry_id: str = Query(...),
    kb_project_id: str | None = Query(
        None,
        description="省略时返回该条目在所有 project_id（含 __all__）下的关联合并",
    ),
):
    if kb_project_id is not None and kb_project_id != "":
        items = await kb_kg_link_service.list_for_entry(
            kb_entry_id=kb_entry_id,
            kb_project_id=kb_project_id,
        )
    else:
        items = await kb_kg_link_service.list_for_entry_all_projects(
            kb_entry_id=kb_entry_id,
        )
    return {"items": items}


@router.post("/kg-links")
async def kb_add_kg_link(body: KbKgLinkCreate):
    try:
        row = await kb_kg_link_service.add_link(
            kb_entry_id=body.kb_entry_id.strip(),
            kb_project_id=body.kb_project_id.strip(),
            kg_kind=body.kg_kind.strip(),
            kg_node_id=body.kg_node_id.strip(),
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        kb_route_logger.warning("kb kg-link duplicate: %s", e)
        raise HTTPException(status_code=409, detail="关联已存在") from e
    return row


@router.delete("/kg-links/{link_id}")
async def kb_delete_kg_link(link_id: str):
    ok = await kb_kg_link_service.delete_link(link_id)
    if not ok:
        raise HTTPException(status_code=404, detail="关联不存在")
    return {"ok": True}


# --- Endpoints ---

@router.get("/query-all", response_model=KBQueriesResponse)
async def kb_query_all(
    q: str = Query(..., description="检索文本"),
    n: int = Query(10, ge=1, le=100),
    project_id: Optional[str] = Query(None),
    collection: Optional[str] = Query(
        None,
        description="可选：限定单个 collection；省略则为全库",
    ),
):
    """跨 collection 合并检索（验证用）；上行可用时逐集合调 Chroma。"""
    result = await kb_proxy_service.query_all_collections(
        query_text=q,
        n_results=n,
        project_id=project_id,
        collection=collection,
    )
    return KBQueriesResponse(
        results=result.get("results", []),
        source=result.get("source", "cache"),
        count=int(result.get("count", 0)),
        warning=result.get("warning"),
    )


@router.get("/health", response_model=KBHealthResponse)
async def kb_health():
    """
    知识库健康检查

    返回外部 ChromaDB 连接状态和本地缓存统计。
    """
    health = await kb_proxy_service.health_check()
    return KBHealthResponse(
        external_kb=health["external_kb"],
        cache_mode=health["cache_mode"],
        cached_entries=health["cached_entries"],
        readonly_mode=bool(health["cache_mode"]),
    )


@router.post("/query", response_model=KBQueriesResponse)
async def kb_query(data: KBQueriesRequest):
    """
    按 collection 名称查询知识库

    优先透传到外部 ChromaDB；外部服务不可用时自动降级到本地缓存。
    """
    result = await kb_proxy_service.query_collection(
        collection_name=data.collection_name,
        query_text=data.query_text,
        n_results=data.n_results,
        project_id=data.project_id,
    )
    return KBQueriesResponse(**result)


@router.get("/collections/{name}/query", response_model=KBQueriesResponse)
async def kb_query_by_collection(
    name: str,
    q: str = Query(..., description="查询文本"),
    n: int = Query(10, ge=1, le=100, description="返回条数"),
    project_id: Optional[str] = Query(None, description="项目 ID"),
):
    """
    GET 风格的 collection 查询接口

    支持路径参数指定 collection 名。
    """
    result = await kb_proxy_service.query_collection(
        collection_name=name,
        query_text=q,
        n_results=n,
        project_id=project_id,
    )
    return KBQueriesResponse(**result)


@router.get("/collections", response_model=CollectionListResponse)
async def list_collections(project_id: Optional[str] = Query(None)):
    """
    列出所有可用 collection

    优先从 ChromaDB 获取；降级时从本地缓存读取。
    """
    result = await kb_proxy_service.list_collections(project_id=project_id)
    return CollectionListResponse(**result)


@router.get("/cache/stats/{project_id}", response_model=CacheStatsResponse)
async def cache_stats(project_id: str):
    """
    获取指定项目的本地缓存统计
    """
    stats = await kb_cache_service.get_cache_stats(project_id=project_id)
    return CacheStatsResponse(**stats)


@router.get("/cache/entry/{entry_id}")
async def get_cached_entry_by_id(entry_id: str):
    """按主键拉取单条缓存（目录树条目可能未出现在前几页 browse 列表中）。"""
    row = await kb_cache_service.get_cached_entry_by_id(entry_id)
    if not row:
        raise HTTPException(status_code=404, detail="缓存条目不存在")
    return row


@router.get("/cache/entries/{project_id}")
async def get_cached_entries(
    project_id: str,
    collection: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=8000),
    offset: int = Query(0, ge=0),
):
    """
    读取本地 kb_cache 缓存条目（不依赖外部 ChromaDB）。

    `project_id` 为 `__all__`、`all` 或 `*` 时表示跨项目汇总（不按 project_id 过滤）。
    """
    entries = await kb_cache_service.get_cached_entries(
        project_id=project_id,
        collection=collection,
        limit=limit,
        offset=offset,
    )
    return {"entries": entries, "count": len(entries)}


@router.post("/cache/sync", response_model=SyncResponse)
async def sync_from_external(data: SyncRequest):
    """
    手动触发从外部 ChromaDB 同步元数据到本地 kb_cache 表
    """
    result = await kb_cache_service.sync_from_external(
        external_kb_url=data.external_kb_url,
        project_id=data.project_id,
        collections=data.collections,
    )
    return SyncResponse(
        synced=result["synced"],
        failed=result["failed"],
        skipped=result["skipped"],
        readonly_mode=kb_cache_service._sync_mode,
    )
