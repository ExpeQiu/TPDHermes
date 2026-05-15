"""
KBProxy 服务：外部 ChromaDB/LLM 服务的 REST 代理层

职责：
1. 透明透传到外部 ChromaDB 服务
2. ChromaDB 不可用时自动降级到本地 SQLite kb_cache 缓存
3. 提供统一的知识查询接口
"""

import logging
import os
from typing import Any, Optional

import httpx

from backend.services.kb_cache import kb_cache_service

logger = logging.getLogger("tpdx.hermes")

# 外部 ChromaDB 服务地址（可通过环境变量覆盖）
CHROMA_HOST = os.getenv("CHROMA_HOST", "http://localhost:8001")


async def _notify_kb(event_type: str, **kwargs: Any) -> None:
    try:
        from backend.routes.kb_sse import notify_kb_event

        await notify_kb_event(event_type, **kwargs)
    except Exception:
        pass


class KBProxyService:
    """
    知识库代理服务

    策略：
    - 优先访问外部 ChromaDB（实时数据）
    - 外部服务不可用时，降级查询本地 SQLite kb_cache
    - 降级模式下写操作会被拒绝（只读缓存模式）
    - 上游恢复后在一次成功心跳/成功 Chroma 请求后清除 _readonly_mode（避免粘性降级）
    """

    def __init__(self, chroma_host: str = CHROMA_HOST):
        self.chroma_host = chroma_host
        self._readonly_mode = False
        self._health_cache: Optional[dict] = None

    def _clear_readonly_after_upstream_ok(self) -> None:
        self._readonly_mode = False

    async def _probe_chroma(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(f"{self.chroma_host}/api/v1/heartbeat")
                return resp.status_code == 200
        except Exception:
            return False

    async def health_check(self) -> dict:
        """
        健康检查：探测外部 ChromaDB 是否可达

        Returns:
            {"external_kb": "up"|"down", "cache_mode": bool, "cached_entries": int}
        """
        cache_stats = await kb_cache_service.get_cache_stats(project_id="__health__")

        external_ok = await self._probe_chroma()
        if external_ok:
            # 上游已恢复：清除代理层粘性只读（与「曾 fallback」解耦）
            self._clear_readonly_after_upstream_ok()

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
        """
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
                    self._clear_readonly_after_upstream_ok()
                    data = resp.json()
                    docs_outer = data.get("documents", [])
                    metas_outer = data.get("metadatas", [])
                    dists_outer = data.get("distances", [])

                    if isinstance(docs_outer, list) and len(docs_outer) > 0 and isinstance(docs_outer[0], list):
                        docs = docs_outer[0]
                    else:
                        docs = docs_outer if isinstance(docs_outer, list) else []

                    if isinstance(metas_outer, list) and len(metas_outer) > 0 and isinstance(metas_outer[0], list):
                        metas = metas_outer[0]
                    else:
                        metas = metas_outer if isinstance(metas_outer, list) else []

                    if isinstance(dists_outer, list) and len(dists_outer) > 0 and isinstance(dists_outer[0], list):
                        dists = dists_outer[0]
                    else:
                        dists = dists_outer if isinstance(dists_outer, list) else []

                    results = []
                    for doc, meta, dist in zip(docs, metas, dists):
                        m = dict(meta or {})
                        if "collection" not in m:
                            m["collection"] = collection_name
                        results.append(
                            {
                                "content": doc,
                                "metadata": m,
                                "distance": dist,
                            }
                        )
                    return {
                        "results": results,
                        "source": "chroma",
                        "count": len(results),
                    }
        except Exception as e:
            logger.debug("chroma query_collection failed: %s", e)

        # 降级：回退到本地缓存
        self._readonly_mode = True
        await _notify_kb("query_fallback", source="kb_proxy", collection=collection_name)
        cached = await kb_cache_service.get_cached_entries(
            project_id=project_id or "__all__",
            collection=collection_name,
            limit=n_results,
        )
        return {
            "results": [
                {
                    "content": e["content"],
                    "metadata": {**(e.get("metadata") or {}), "collection": collection_name},
                    "distance": 1.0 - float(e.get("reliability", 0.5)),
                }
                for e in cached
            ],
            "source": "cache",
            "count": len(cached),
            "warning": "readonly cache mode - external KB unavailable",
        }

    async def query_all_collections(
        self,
        query_text: str,
        n_results: int = 10,
        project_id: Optional[str] = None,
        collection: Optional[str] = None,
    ) -> dict:
        """
        跨全部（或单个）collection 检索并合并结果；上行正常时逐 collection 调 Chroma。
        """
        col_res = await self.list_collections(project_id=project_id)
        names_all = [str(x) for x in (col_res.get("collections") or []) if x]
        if collection:
            names = [collection] if collection in names_all else []
        else:
            names = names_all

        if not names:
            return {
                "results": [],
                "source": col_res.get("source", "none"),
                "count": 0,
                "warning": col_res.get("warning"),
            }

        if col_res.get("source") == "chroma":
            per = max(2, min(30, max(n_results * 3 // max(len(names), 1), n_results)))
            merged: list[dict[str, Any]] = []
            try:
                async with httpx.AsyncClient(timeout=15.0) as client:
                    for col_name in names:
                        resp = await client.post(
                            f"{self.chroma_host}/api/v1/collections/{col_name}/query",
                            json={
                                "query_texts": [query_text],
                                "n_results": per,
                                "include": ["documents", "metadatas", "distances"],
                            },
                        )
                        if resp.status_code != 200:
                            continue
                        self._clear_readonly_after_upstream_ok()
                        data = resp.json()
                        docs_outer = data.get("documents", [])
                        metas_outer = data.get("metadatas", [])
                        dists_outer = data.get("distances", [])
                        if isinstance(docs_outer, list) and docs_outer and isinstance(docs_outer[0], list):
                            docs = docs_outer[0]
                        else:
                            docs = docs_outer if isinstance(docs_outer, list) else []
                        if isinstance(metas_outer, list) and metas_outer and isinstance(metas_outer[0], list):
                            metas = metas_outer[0]
                        else:
                            metas = metas_outer if isinstance(metas_outer, list) else []
                        if isinstance(dists_outer, list) and dists_outer and isinstance(dists_outer[0], list):
                            dists = dists_outer[0]
                        else:
                            dists = dists_outer if isinstance(dists_outer, list) else []

                        for doc, meta, dist in zip(docs, metas, dists):
                            m = dict(meta or {})
                            m["collection"] = m.get("collection") or col_name
                            merged.append(
                                {
                                    "content": doc,
                                    "metadata": m,
                                    "distance": dist,
                                }
                            )
                merged.sort(key=lambda r: float(r.get("distance") or 1.0))
                sliced = merged[:n_results]
                return {"results": sliced, "source": "chroma", "count": len(sliced)}
            except Exception as e:
                logger.debug("chroma query_all failed, fallback cache: %s", e)

        # 全缓存：子串检索（验证用）
        self._readonly_mode = True
        await _notify_kb("query_fallback", source="kb_proxy", collection="__multi__")
        q_lower = (query_text or "").lower()
        combined: list[dict[str, Any]] = []
        for col_name in names:
            cached = await kb_cache_service.get_cached_entries(
                project_id=project_id or "__all__",
                collection=col_name,
                limit=2000,
            )
            for e in cached:
                body = (e.get("content") or "").lower()
                if q_lower in body:
                    combined.append(
                        {
                            "content": e["content"],
                            "metadata": {
                                **(e.get("metadata") or {}),
                                "collection": col_name,
                            },
                            "distance": 1.0 - float(e.get("reliability", 0.5)),
                        }
                    )
        combined.sort(key=lambda r: float(r.get("distance") or 1.0))
        sliced = combined[:n_results]
        return {
            "results": sliced,
            "source": "cache",
            "count": len(sliced),
            "warning": col_res.get("warning") or "readonly cache mode - multi collection scan",
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
                    self._clear_readonly_after_upstream_ok()
                    collections = resp.json()
                    return {
                        "collections": [
                            c.get("name") or c.get("id") for c in collections
                        ],
                        "source": "chroma",
                    }
        except Exception as e:
            logger.debug("chroma list_collections failed: %s", e)

        self._readonly_mode = True
        stats = await kb_cache_service.get_cache_stats(project_id=project_id or "__all__")
        return {
            "collections": stats.get("collections", []),
            "source": "cache",
            "warning": "readonly cache mode",
        }


# 全局单例
kb_proxy_service = KBProxyService()
