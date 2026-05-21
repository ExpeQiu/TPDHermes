"""
KBProxy 服务：外部 ChromaDB/LLM 服务的 REST 代理层

职责：
1. 透明透传到外部 ChromaDB 服务
2. ChromaDB 不可用时自动降级到本地 SQLite kb_cache 缓存
3. 提供统一的知识查询接口
"""

import asyncio
import logging
import os
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

    @staticmethod
    def _extract_collection_ref(item: Any) -> str | None:
        if isinstance(item, str):
            return item
        if isinstance(item, dict):
            return str(item.get("name") or item.get("id") or "") or None
        return None

    async def _resolve_collection_ref(self, name_or_id: str) -> str:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(f"{self.chroma_host}/api/v1/collections")
                if resp.status_code != 200:
                    return name_or_id
                data = resp.json()
                if not isinstance(data, list):
                    return name_or_id
                for item in data:
                    if isinstance(item, str):
                        if item == name_or_id:
                            return name_or_id
                        continue
                    if not isinstance(item, dict):
                        continue
                    item_name = item.get("name")
                    item_id = item.get("id")
                    if item_name == name_or_id or item_id == name_or_id:
                        return str(item_id or item_name)
        except Exception:
            return name_or_id
        return name_or_id

    async def _query_collection_via_get(
        self,
        collection_ref: str,
        collection_name: str,
        query_text: str,
        n_results: int,
    ) -> dict[str, Any] | None:
        q = (query_text or "").strip()
        if not q:
            return None
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(
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
        if resp.status_code == 422 and "query_texts" in payload and embed_enabled():
            q = (query_text or "").strip()
            if q:
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
    ) -> list[tuple[str, dict[str, Any]]]:
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                resp = await client.post(
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
        except Exception as e:
            logger.debug("chroma fetch documents failed: %s", e)
            return []

    async def _query_collection_via_local_embed(
        self,
        collection_ref: str,
        collection_name: str,
        query_text: str,
        n_results: int,
    ) -> dict[str, Any] | None:
        q = (query_text or "").strip()
        if not q or not embed_enabled():
            return None

        pairs = await self._fetch_collection_documents(
            collection_ref,
            limit=local_rank_max_docs(),
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
            texts = [q] + [item[2] for item in searchable]
            vectors = await asyncio.to_thread(embed_texts_sync, texts)
        except Exception as e:
            logger.warning("local embed rank failed collection=%s err=%s", collection_name, e)
            return None

        if not vectors or len(vectors) < 2:
            return None

        q_vec = vectors[0]
        doc_vecs = vectors[1:]
        scores = cosine_scores(q_vec, doc_vecs)
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
            return None
        return build_query_result(
            results,
            source="chroma",
            warning="local_embed_rank_fallback",
        )

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
        cache_stats = await kb_cache_service.get_cache_stats(project_id="__all__")

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
            collection_ref = await self._resolve_collection_ref(collection_name)
            async with httpx.AsyncClient(timeout=15.0) as client:
                semantic = await self._post_chroma_query(
                    client,
                    collection_ref,
                    collection_name,
                    query_text,
                    n_results,
                )
                if semantic and int(semantic.get("count") or 0) > 0:
                    return semantic

                local = await self._query_collection_via_local_embed(
                    collection_ref,
                    collection_name,
                    query_text,
                    n_results,
                )
                if local and int(local.get("count") or 0) > 0:
                    return local

                if (query_text or "").strip():
                    contains_fallback = await self._query_collection_via_get(
                        collection_ref=collection_ref,
                        collection_name=collection_name,
                        query_text=query_text,
                        n_results=n_results,
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
                async with httpx.AsyncClient(timeout=20.0) as client:
                    for col_name in names:
                        collection_ref = await self._resolve_collection_ref(col_name)
                        hit = await self._post_chroma_query(
                            client,
                            collection_ref,
                            col_name,
                            query_text,
                            per,
                        )
                        if hit and hit.get("results"):
                            merged.extend(hit["results"])
                            continue
                        local = await self._query_collection_via_local_embed(
                            collection_ref,
                            col_name,
                            query_text,
                            per,
                        )
                        if local and local.get("results"):
                            merged.extend(local["results"])
                            continue
                        fallback = await self._query_collection_via_get(
                            collection_ref=collection_ref,
                            collection_name=col_name,
                            query_text=query_text,
                            n_results=per,
                        )
                        if fallback is not None:
                            merged.extend(fallback["results"])
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


# 全局单例
kb_proxy_service = KBProxyService()
