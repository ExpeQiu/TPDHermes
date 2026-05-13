"""
知识库路由：提供 KB 健康检查、collection 查询等接口
"""

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional

from backend.services.kb_proxy import kb_proxy_service
from backend.services.kb_cache import kb_cache_service

router = APIRouter(prefix="/kb", tags=["knowledge_base"])


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


# --- Endpoints ---

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
        readonly_mode=kb_proxy_service._readonly_mode,
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


@router.get("/cache/entries/{project_id}")
async def get_cached_entries(
    project_id: str,
    collection: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
):
    """
    读取本地 kb_cache 缓存条目（不依赖外部 ChromaDB）
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
