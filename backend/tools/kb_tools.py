"""
Knowledge Base Tools for TPDHermes MCP Server

Wraps kb_proxy_service and kb_cache_service for MCP access.
"""

from typing import Optional

from backend.services.kb_proxy import kb_proxy_service
from backend.services.kb_cache import kb_cache_service


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
    return await kb_proxy_service.query_collection(
        collection_name=collection_name,
        query_text=query,
        n_results=limit,
        project_id=project_id,
    )


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
