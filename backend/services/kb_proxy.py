"""
KBProxy 服务：外部 ChromaDB/LLM 服务的 REST 代理层

职责：
1. 透明透传到外部 ChromaDB 服务
2. ChromaDB 不可用时自动降级到本地 SQLite kb_cache 缓存
3. 提供统一的知识查询接口
"""

import json
from typing import Optional
import httpx

from backend.services.kb_cache import kb_cache_service


# 外部 ChromaDB 服务地址（可通过环境变量覆盖）
CHROMA_HOST = "http://localhost:8001"


class KBProxyService:
    """
    知识库代理服务

    策略：
    - 优先访问外部 ChromaDB（实时数据）
    - 外部服务不可用时，降级查询本地 SQLite kb_cache
    - 降级模式下写操作会被拒绝（只读缓存模式）
    """

    def __init__(self, chroma_host: str = CHROMA_HOST):
        self.chroma_host = chroma_host
        self._readonly_mode = False
        self._health_cache: Optional[dict] = None

    async def health_check(self) -> dict:
        """
        健康检查：探测外部 ChromaDB 是否可达

        Returns:
            {"external_kb": "up"|"down", "cache_mode": bool, "cached_entries": int}
        """
        cache_stats = await kb_cache_service.get_cache_stats(project_id="__health__")

        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(f"{self.chroma_host}/api/v1/heartbeat")
                external_ok = resp.status_code == 200
        except Exception:
            external_ok = False

        return {
            "external_kb": "up" if external_ok else "down",
            "cache_mode": self._readonly_mode or not external_ok,
            "cached_entries": cache_stats.get("total_entries", 0),
        }

    async def query_collection(
        self,
        collection_name: str,
        query_text: str,
        n_results: int = 10,
        project_id: Optional[str] = None,
    ) -> dict:
        """
        按 collection 名称查询知识库

        优先透传到外部 ChromaDB；降级时回退到本地缓存。

        Args:
            collection_name: ChromaDB collection 名称
            query_text: 查询文本（用于 embedding）
            n_results: 返回条数
            project_id: 可选，限定只返回该项目下的缓存条目

        Returns:
            {"results": [...], "source": "chroma"|"cache", "count": int}
        """
        # 先尝试外部 ChromaDB
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(
                    f"{self.chroma_host}/api/v1/collections/{collection_name}/query",
                    json={
                        "query_texts": [query_text],
                        "n_results": n_results,
                        "include": ["documents", "metadatas", "distances"],
                    },
                )
                if resp.status_code == 200:
                    data = resp.json()
                    return {
                        "results": [
                            {
                                "content": doc,
                                "metadata": meta or {},
                                "distance": dist,
                            }
                            for doc, meta, dist in zip(
                                data.get("documents", [[]])[0]
                                if isinstance(data.get("documents"), list)
                                and len(data.get("documents")) > 0
                                else data.get("documents", []),
                                data.get("metadatas", [[]])[0]
                                if isinstance(data.get("metadatas"), list)
                                and len(data.get("metadatas")) > 0
                                else data.get("metadatas", []),
                                data.get("distances", [[]])[0]
                                if isinstance(data.get("distances"), list)
                                and len(data.get("distances")) > 0
                                else data.get("distances", []),
                            )
                        ],
                        "source": "chroma",
                        "count": len(data.get("documents", [[]])[0])
                        if isinstance(data.get("documents"), list)
                        and len(data.get("documents")) > 0
                        else 0,
                    }
        except Exception:
            pass

        # 降级：回退到本地缓存
        self._readonly_mode = True
        cached = await kb_cache_service.get_cached_entries(
            project_id=project_id or "__all__",
            collection=collection_name,
            limit=n_results,
        )
        return {
            "results": [
                {
                    "content": e["content"],
                    "metadata": e["metadata"],
                    "distance": 1.0 - e.get("reliability", 0.5),  # 可靠性转距离
                }
                for e in cached
            ],
            "source": "cache",
            "count": len(cached),
            "warning": "readonly cache mode - external KB unavailable",
        }

    async def list_collections(self, project_id: Optional[str] = None) -> dict:
        """
        列出可用 collection

        优先从 ChromaDB 获取；降级时从本地缓存获取。
        """
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(f"{self.chroma_host}/api/v1/collections")
                if resp.status_code == 200:
                    collections = resp.json()
                    return {
                        "collections": [
                            c.get("name") or c.get("id") for c in collections
                        ],
                        "source": "chroma",
                    }
        except Exception:
            pass

        # 降级：读取本地缓存的 collection 列表
        self._readonly_mode = True
        stats = await kb_cache_service.get_cache_stats(project_id=project_id or "__all__")
        return {
            "collections": stats.get("collections", []),
            "source": "cache",
            "warning": "readonly cache mode",
        }


# 全局单例
kb_proxy_service = KBProxyService()
