"""
Knowledge Base Tools for TPDHermes MCP Server

Wraps kb_proxy_service and kb_cache_service for MCP access.
"""

from typing import Any, Optional

from backend.services.kb_proxy import kb_proxy_service
from backend.services.kb_cache import kb_cache_service
from backend.services.kb_write import add_kb_harvest_entry
from backend.services.project_kb import is_project_kb_collection


def _metadata_published(meta: dict) -> bool:
    pub = (meta or {}).get("published")
    if isinstance(pub, bool):
        return pub
    if isinstance(pub, str):
        return pub.strip().lower() in ("1", "true", "yes", "on")
    return bool(pub)


def _filter_project_kb_results(result: dict, collection_name: str) -> dict:
    if not is_project_kb_collection(collection_name):
        return result
    rows = result.get("results") or []
    kept = [r for r in rows if _metadata_published((r or {}).get("metadata") or {})]
    out = dict(result)
    out["results"] = kept
    out["count"] = len(kept)
    return out


async def kb_query(
    query: str,
    collection_name: str,
    limit: int = 10,
    project_id: Optional[str] = None,
) -> dict:
    """
    Query the knowledge base.

    Args:
        query: Query text (used for embedding similarity search)
        collection_name: ChromaDB collection name to query
        limit: Maximum number of results to return
        project_id: Optional project ID to filter results

    Returns:
        {
            "results": [{"content": str, "metadata": dict, "distance": float}, ...],
            "source": "chroma" | "cache",
            "count": int,
            "warning": Optional[str]
        }
    """
    result = await kb_proxy_service.query_collection(
        collection_name=collection_name,
        query_text=query,
        n_results=limit,
        project_id=project_id,
    )
    return _filter_project_kb_results(result, collection_name)


async def kb_list_collections(project_id: Optional[str] = None) -> dict:
    """
    List all available knowledge base collections.

    Args:
        project_id: Optional project ID to filter collections

    Returns:
        {
            "collections": [str, ...],
            "source": "chroma" | "cache",
            "warning": Optional[str]
        }
    """
    return await kb_proxy_service.list_collections(project_id=project_id)


async def kb_get_entry(
    collection_name: str,
    entry_id: str,
    project_id: str,
) -> dict:
    """
    Retrieve a specific knowledge base entry by ID.

    Args:
        collection_name: Collection name to search within
        entry_id: The entry ID to retrieve
        project_id: Project ID for cache scope

    Returns:
        Entry dict with id, content, metadata, source, reliability, etc.
        Returns empty dict if not found.
    """
    entries = await kb_cache_service.get_cached_entries(
        project_id=project_id,
        collection=collection_name,
        limit=1000,
    )
    for entry in entries:
        if entry.get("id") == entry_id:
            return entry
    return {}


async def kb_add_entry(
    collection_name: str,
    project_id: str,
    title: str,
    content: str,
    summary: str = "",
    tags: Optional[list[str]] = None,
    domain: str = "internal_methodology",
    source: str = "hermes_chat",
    published: bool = False,
    metadata: Optional[dict[str, Any]] = None,
    scenario_id: Optional[str] = None,
) -> dict:
    """
    将对话中已确认的摘录写入知识库（默认草稿 unpublished）。

    禁止在未取得用户明确同意时调用。须先展示草稿并请用户确认「是否存入知识库」。
    """
    return await add_kb_harvest_entry(
        collection_name=collection_name,
        project_id=project_id,
        title=title,
        content=content,
        summary=summary or None,
        tags=tags,
        domain=domain,
        source=source,
        published=published,
        metadata=metadata,
        scenario_id=scenario_id,
        strict_domain=False,
    )
