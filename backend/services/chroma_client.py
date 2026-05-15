"""
Chroma HTTP 客户端：路径与 kb_proxy 一致（/api/v1/...）。
供离线脚本与 kb ingestion API 复用。
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

import httpx

logger = logging.getLogger("tpdx.hermes")


def chroma_sanitize_metadata(meta: dict[str, Any]) -> dict[str, Any]:
    """Chroma metadata 仅稳定支持标量；list/dict 序列化为 JSON 字符串。"""
    out: dict[str, Any] = {}
    for k, v in (meta or {}).items():
        if v is None:
            continue
        if isinstance(v, (str, int, float, bool)):
            out[str(k)] = v
        elif isinstance(v, (list, dict)):
            out[str(k)] = json.dumps(v, ensure_ascii=False)
        else:
            out[str(k)] = str(v)
    return out


def flatten_chroma_get_ids(data: dict[str, Any]) -> list[str]:
    ids = data.get("ids") or []
    if ids and isinstance(ids[0], list):
        ids = ids[0]
    return [str(x) for x in ids if x is not None]


class ChromaHttpClient:
    """同步 HTTP 客户端（脚本、asyncio.to_thread 内调用）。"""

    def __init__(self, base_url: str, timeout: float = 120.0):
        self.base_url = str(base_url).rstrip("/")
        self.timeout = timeout

    def heartbeat(self) -> bool:
        try:
            r = httpx.get(f"{self.base_url}/api/v1/heartbeat", timeout=min(10.0, self.timeout))
            return r.status_code == 200
        except Exception as e:
            logger.debug("chroma heartbeat failed: %s", e)
            return False

    def list_collections(self) -> list[dict[str, Any]]:
        r = httpx.get(f"{self.base_url}/api/v1/collections", timeout=self.timeout)
        r.raise_for_status()
        raw = r.json()
        return raw if isinstance(raw, list) else []

    def collection_names(self) -> list[str]:
        names: list[str] = []
        for c in self.list_collections():
            n = c.get("name") or c.get("id")
            if n is not None:
                names.append(str(n))
        return names

    def create_collection(self, name: str, metadata: Optional[dict] = None) -> None:
        body = {"name": name, "metadata": metadata or {}}
        r = httpx.post(
            f"{self.base_url}/api/v1/collections",
            json=body,
            timeout=self.timeout,
        )
        if r.status_code in (200, 201):
            return
        # 已存在等情况
        if r.status_code == 409:
            return
        r.raise_for_status()

    def ensure_collection(self, name: str) -> None:
        if name in self.collection_names():
            return
        try:
            self.create_collection(name)
        except httpx.HTTPStatusError as e:
            logger.warning("chroma create_collection %s: %s", name, e)
            raise

    def upsert(
        self,
        collection: str,
        ids: list[str],
        documents: list[str],
        metadatas: list[dict[str, Any]],
    ) -> None:
        payload = {
            "ids": ids,
            "documents": documents,
            "metadatas": [chroma_sanitize_metadata(m) for m in metadatas],
        }
        r = httpx.post(
            f"{self.base_url}/api/v1/collections/{collection}/upsert",
            json=payload,
            timeout=self.timeout,
        )
        if r.status_code == 404:
            self.ensure_collection(collection)
            r = httpx.post(
                f"{self.base_url}/api/v1/collections/{collection}/upsert",
                json=payload,
                timeout=self.timeout,
            )
        r.raise_for_status()

    def get_by_where(
        self,
        collection: str,
        where: dict[str, Any],
        limit: int = 10_000,
        offset: int = 0,
        include: Optional[list[str]] = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "where": where,
            "limit": limit,
            "offset": offset,
            "include": include or ["metadatas", "documents"],
        }
        r = httpx.post(
            f"{self.base_url}/api/v1/collections/{collection}/get",
            json=body,
            timeout=self.timeout,
        )
        r.raise_for_status()
        return r.json()

    def update(
        self,
        collection: str,
        ids: list[str],
        metadatas: list[dict[str, Any]],
    ) -> None:
        payload = {
            "ids": ids,
            "metadatas": [chroma_sanitize_metadata(m) for m in metadatas],
        }
        r = httpx.post(
            f"{self.base_url}/api/v1/collections/{collection}/update",
            json=payload,
            timeout=self.timeout,
        )
        r.raise_for_status()

    def delete(self, collection: str, ids: list[str]) -> None:
        if not ids:
            return
        r = httpx.post(
            f"{self.base_url}/api/v1/collections/{collection}/delete",
            json={"ids": ids},
            timeout=self.timeout,
        )
        r.raise_for_status()
