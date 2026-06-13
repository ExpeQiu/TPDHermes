"""
KBProxy 服务：外部 ChromaDB/LLM 服务的 REST 代理层

职责：
1. 透明透传到外部 ChromaDB 服务
2. ChromaDB 不可用时自动降级到本地 SQLite kb_cache 缓存
3. 提供统一的知识查询接口
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Optional

import httpx

from backend.services.kb_cache import kb_cache_service
from backend.services.kb_chroma_query import build_query_result, parse_chroma_query_response
from backend.services.kb_embedding import (
    cosine_scores,
    embed_enabled,
    embed_query_texts,
    embed_texts_sync,
    extract_searchable_text,
    local_rank_max_docs,
)

logger = logging.getLogger("tpdx.hermes")

CHROMA_HOST = os.getenv("CHROMA_HOST", "http://localhost:8001")
_REF_MAP_TTL_SEC = float(os.getenv("KB_REF_MAP_TTL_SEC", "60"))
_LOCAL_RANK_CACHE_TTL_SEC = float(os.getenv("KB_LOCAL_RANK_CACHE_TTL_SEC", "300"))


async def _notify_kb(event_type: str, **kwargs: Any) -> None:
    try:
        from backend.routes.kb_sse import notify_kb_event

        await notify_kb_event(event_type, **kwargs)
    except Exception:
        pass


@dataclass
class _LocalRankCacheEntry:
    monotonic_ts: float
    searchable: list[tuple[str, dict[str, Any], str]]
    doc_vectors: list[list[float]]


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
        self._ref_map_cache: tuple[float, dict[str, str]] | None = None
        self._local_rank_cache: dict[tuple[str, int], _LocalRankCacheEntry] = {}
        self._cache_lock = asyncio.Lock()

    def _clear_readonly_after_upstream_ok(self) -> None:
        self._readonly_mode = False

    def clear_caches(self) -> None:
        """测试或 ingest 后可选调用。"""
        self._ref_map_cache = None
        self._local_rank_cache.clear()

    @staticmethod
    def _extract_collection_ref(item: Any) -> str | None:
        if isinstance(item, str):
            return item
        if isinstance(item, dict):
            return str(item.get("name") or item.get("id") or "") or None
        return None

    @staticmethod
    def _build_ref_map_from_list(data: list[Any]) -> dict[str, str]:
        ref_map: dict[str, str] = {}
        for item in data:
            if isinstance(item, str):
                ref_map[item] = item
                continue
            if not isinstance(item, dict):
                continue
            item_name = item.get("name")
            item_id = item.get("id")
            ref = str(item_id or item_name or "")
            if not ref:
                continue
            ref_map[ref] = ref
            if item_name:
                ref_map[str(item_name)] = ref
            if item_id and item_id != item_name:
                ref_map[str(item_id)] = ref
        return ref_map

    async def _fetch_collection_ref_map(
        self,
        client: httpx.AsyncClient | None = None,
    ) -> dict[str, str]:
        now = time.monotonic()
        if self._ref_map_cache and now - self._ref_map_cache[0] < _REF_MAP_TTL_SEC:
            return self._ref_map_cache[1]

        async def _load(c: httpx.AsyncClient) -> dict[str, str]:
            resp = await c.get(f"{self.chroma_host}/api/v1/collections")
            if resp.status_code != 200:
                return {}
            data = resp.json()
            if not isinstance(data, list):
                return {}
            return self._build_ref_map_from_list(data)

        try:
            if client is not None:
                ref_map = await _load(client)
            else:
                async with httpx.AsyncClient(timeout=5.0) as c:
                    ref_map = await _load(c)
        except Exception:
            ref_map = {}

        if ref_map:
            self._ref_map_cache = (now, ref_map)
        return ref_map

    async def _resolve_collection_ref(
        self,
        name_or_id: str,
        client: httpx.AsyncClient | None = None,
    ) -> str:
        ref_map = await self._fetch_collection_ref_map(client)
        if ref_map:
            return ref_map.get(name_or_id, name_or_id)
        return name_or_id

    async def _query_collection_via_get(
        self,
        collection_ref: str,
        collection_name: str,
        query_text: str,
        n_results: int,
        *,
        client: httpx.AsyncClient | None = None,
    ) -> dict[str, Any] | None:
        q = (query_text or "").strip()
        if not q:
            return None

        async def _do_get(c: httpx.AsyncClient) -> dict[str, Any] | None:
            resp = await c.post(
                f"{self.chroma_host}/api/v1/collections/{collection_ref}/get",
                json={
                    "where_document": {"$contains": q},
                    "limit": n_results,
                    "offset": 0,
                    "include": ["documents", "metadatas"],
                },
            )
            if resp.status_code != 200:
                return None
            data = resp.json()
            docs = data.get("documents") or []
            metas = data.get("metadatas") or []
            results = []
            for doc, meta in zip(docs, metas):
                m = dict(meta or {})
                if "collection" not in m:
                    m["collection"] = collection_name
                results.append(
                    {
                        "content": doc,
                        "metadata": m,
                        "distance": 0.0,
                    }
                )
            return {
                "results": results,
                "source": "chroma",
                "count": len(results),
            }

        try:
            if client is not None:
                return await _do_get(client)
            async with httpx.AsyncClient(timeout=10.0) as c:
                return await _do_get(c)
        except Exception:
            return None

    async def _build_chroma_query_payload(
        self,
        query_text: str,
        n_results: int,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "n_results": n_results,
            "include": ["documents", "metadatas", "distances"],
        }
        q = (query_text or "").strip()
        if embed_enabled() and q:
            embeddings = await embed_query_texts([q])
            if embeddings and embeddings[0]:
                payload["query_embeddings"] = embeddings
                return payload
            logger.warning("kb embed query returned empty vectors, fallback query_texts")
        if q:
            payload["query_texts"] = [q]
        return payload

    async def _post_chroma_query(
        self,
        client: httpx.AsyncClient,
        collection_ref: str,
        collection_name: str,
        query_text: str,
        n_results: int,
    ) -> dict[str, Any] | None:
        payload = await self._build_chroma_query_payload(query_text, n_results)
        resp = await client.post(
            f"{self.chroma_host}/api/v1/collections/{collection_ref}/query",
            json=payload,
        )
        q = (query_text or "").strip()
        if resp.status_code == 422 and embed_enabled() and q:
            if "query_texts" in payload or "query_embeddings" not in payload:
                embeddings = await embed_query_texts([q])
                if embeddings and embeddings[0]:
                    retry_payload = {
                        "query_embeddings": embeddings,
                        "n_results": n_results,
                        "include": ["documents", "metadatas", "distances"],
                    }
                    resp = await client.post(
                        f"{self.chroma_host}/api/v1/collections/{collection_ref}/query",
                        json=retry_payload,
                    )
        if resp.status_code != 200:
            logger.info(
                "chroma query non-200 collection=%s status=%s body=%s",
                collection_name,
                resp.status_code,
                (resp.text or "")[:300],
            )
            return None
        self._clear_readonly_after_upstream_ok()
        results = parse_chroma_query_response(resp.json(), collection_name=collection_name)
        return build_query_result(results, source="chroma")

    async def _fetch_collection_documents(
        self,
        collection_ref: str,
        *,
        limit: int,
        client: httpx.AsyncClient | None = None,
    ) -> list[tuple[str, dict[str, Any]]]:
        async def _do_fetch(c: httpx.AsyncClient) -> list[tuple[str, dict[str, Any]]]:
            resp = await c.post(
                f"{self.chroma_host}/api/v1/collections/{collection_ref}/get",
                json={
                    "limit": limit,
                    "offset": 0,
                    "include": ["documents", "metadatas"],
                },
            )
            if resp.status_code != 200:
                return []
            data = resp.json()
            docs = data.get("documents") or []
            metas = data.get("metadatas") or []
            if docs and isinstance(docs[0], list):
                docs = docs[0]
            if metas and isinstance(metas[0], list):
                metas = metas[0]
            pairs: list[tuple[str, dict[str, Any]]] = []
            for doc, meta in zip(docs, metas):
                pairs.append((str(doc or ""), dict(meta or {})))
            return pairs

        try:
            if client is not None:
                return await _do_fetch(client)
            async with httpx.AsyncClient(timeout=20.0) as c:
                return await _do_fetch(c)
        except Exception as e:
            logger.debug("chroma fetch documents failed: %s", e)
            return []

    async def _get_local_rank_index(
        self,
        collection_ref: str,
        *,
        limit: int,
        client: httpx.AsyncClient | None = None,
    ) -> tuple[list[tuple[str, dict[str, Any], str]], list[list[float]]] | None:
        key = (collection_ref, limit)
        now = time.monotonic()
        cached = self._local_rank_cache.get(key)
        if cached and now - cached.monotonic_ts < _LOCAL_RANK_CACHE_TTL_SEC:
            return cached.searchable, cached.doc_vectors

        pairs = await self._fetch_collection_documents(
            collection_ref,
            limit=limit,
            client=client,
        )
        if not pairs:
            return None

        searchable: list[tuple[str, dict[str, Any], str]] = []
        for doc, meta in pairs:
            text = extract_searchable_text(doc, meta)
            if text:
                searchable.append((doc, meta, text))
        if not searchable:
            return None

        try:
            doc_vectors = await asyncio.to_thread(
                embed_texts_sync,
                [item[2] for item in searchable],
            )
        except Exception as e:
            logger.warning(
                "local embed index build failed collection_ref=%s err=%s",
                collection_ref,
                e,
            )
            return None
        if not doc_vectors:
            return None

        async with self._cache_lock:
            self._local_rank_cache[key] = _LocalRankCacheEntry(
                now, searchable, doc_vectors
            )
        return searchable, doc_vectors

    async def _query_collection_via_local_embed(
        self,
        collection_ref: str,
        collection_name: str,
        query_text: str,
        n_results: int,
        *,
        client: httpx.AsyncClient | None = None,
    ) -> dict[str, Any] | None:
        q = (query_text or "").strip()
        if not q or not embed_enabled():
            return None

        limit = local_rank_max_docs()
        index = await self._get_local_rank_index(
            collection_ref,
            limit=limit,
            client=client,
        )
        if not index:
            return None

        searchable, doc_vectors = index
        try:
            q_vectors = await asyncio.to_thread(embed_texts_sync, [q])
        except Exception as e:
            logger.warning("local embed rank failed collection=%s err=%s", collection_name, e)
            return None

        if not q_vectors or not q_vectors[0]:
            return None

        q_vec = q_vectors[0]
        scores = cosine_scores(q_vec, doc_vectors)
        ranked = sorted(
            zip(searchable, scores),
            key=lambda x: x[1],
            reverse=True,
        )[:n_results]

        results: list[dict[str, Any]] = []
        for (doc, meta, _text), score in ranked:
            if score < 0:
                continue
            m = dict(meta)
            m.setdefault("collection", collection_name)
            results.append(
                {
                    "content": doc,
                    "metadata": m,
                    "distance": 1.0 - float(score),
                }
            )
        if not results:
            return build_query_result([], source="chroma", warning="local_embed_rank_fallback")
        return build_query_result(
            results,
            source="chroma",
            warning="local_embed_rank_fallback",
        )

    async def _query_collection_on_chroma(
        self,
        client: httpx.AsyncClient,
        collection_ref: str,
        collection_name: str,
        query_text: str,
        n_results: int,
    ) -> dict[str, Any] | None:
        """
        单 collection Chroma 检索：semantic → local embed → keyword（仅 embed 未启用或 local 未拉取到文档时）。
        """
        semantic = await self._post_chroma_query(
            client,
            collection_ref,
            collection_name,
            query_text,
            n_results,
        )
        if semantic and int(semantic.get("count") or 0) > 0:
            return semantic

        q = (query_text or "").strip()
        local: dict[str, Any] | None = None
        if embed_enabled() and q:
            local = await self._query_collection_via_local_embed(
                collection_ref,
                collection_name,
                query_text,
                n_results,
                client=client,
            )
            if local and int(local.get("count") or 0) > 0:
                return local
            # local 已全量扫描：空结果则不再 keyword
            if local is not None:
                return semantic if semantic is not None else local

        if q:
            contains_fallback = await self._query_collection_via_get(
                collection_ref=collection_ref,
                collection_name=collection_name,
                query_text=query_text,
                n_results=n_results,
                client=client,
            )
            if contains_fallback and contains_fallback.get("count", 0) > 0:
                contains_fallback["warning"] = (
                    (contains_fallback.get("warning") or "")
                    + (" | " if contains_fallback.get("warning") else "")
                    + "semantic_empty_used_contains_fallback"
                ).strip(" | ")
                return contains_fallback

        if semantic is not None:
            return semantic
        return local

    async def _probe_chroma(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(f"{self.chroma_host}/api/v1/heartbeat")
                return resp.status_code == 200
        except Exception:
            return False

    async def health_check(self) -> dict:
        cache_stats = await kb_cache_service.get_cache_stats(project_id="__all__")

        external_ok = await self._probe_chroma()
        if external_ok:
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
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                collection_ref = await self._resolve_collection_ref(
                    collection_name, client
                )
                hit = await self._query_collection_on_chroma(
                    client,
                    collection_ref,
                    collection_name,
                    query_text,
                    n_results,
                )
                if hit is not None:
                    return hit
        except Exception as e:
            logger.debug("chroma query_collection failed: %s", e)

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
            try:
                async with httpx.AsyncClient(timeout=20.0) as client:
                    ref_map = await self._fetch_collection_ref_map(client)

                    async def _query_one(col_name: str) -> list[dict[str, Any]]:
                        collection_ref = ref_map.get(col_name, col_name)
                        hit = await self._query_collection_on_chroma(
                            client,
                            collection_ref,
                            col_name,
                            query_text,
                            per,
                        )
                        if hit and hit.get("results"):
                            return list(hit["results"])
                        return []

                    batch = await asyncio.gather(
                        *[_query_one(col_name) for col_name in names],
                        return_exceptions=True,
                    )
                    merged: list[dict[str, Any]] = []
                    for col_name, part in zip(names, batch):
                        if isinstance(part, Exception):
                            logger.debug(
                                "chroma query_all collection=%s failed: %s",
                                col_name,
                                part,
                            )
                            continue
                        merged.extend(part)
                merged.sort(key=lambda r: float(r.get("distance") or 1.0))
                sliced = merged[:n_results]
                return {"results": sliced, "source": "chroma", "count": len(sliced)}
            except Exception as e:
                logger.debug("chroma query_all failed, fallback cache: %s", e)

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

    async def list_collections(
        self,
        project_id: Optional[str] = None,
        *,
        prefer_cache: bool = False,
    ) -> dict:
        if prefer_cache:
            stats = await kb_cache_service.get_cache_stats(project_id=project_id or "__all__")
            return {
                "collections": stats.get("collections", []),
                "source": "cache",
                "warning": "prefer_cache",
            }
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                resp = await client.get(f"{self.chroma_host}/api/v1/collections")
                if resp.status_code == 200:
                    self._clear_readonly_after_upstream_ok()
                    collections = resp.json()
                    if isinstance(collections, list):
                        self._ref_map_cache = (
                            time.monotonic(),
                            self._build_ref_map_from_list(collections),
                        )
                    return {
                        "collections": [
                            self._extract_collection_ref(c) for c in collections
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


kb_proxy_service = KBProxyService()
