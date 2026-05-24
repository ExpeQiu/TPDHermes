"""
KBCache 服务：管理本地 SQLite kb_cache 表，与外部 ChromaDB 保持元数据同步
"""

import json
import uuid
from datetime import datetime
from typing import Any, Optional
from sqlalchemy import select

from backend.models.kb_cache import KBCache
from backend.db import engine, async_session_maker
from backend.db import Base
from backend.services.kb_metadata import normalize_kb_metadata_dict

ALL_PROJECT_IDS = {"__all__", "*", "all"}


class KBCacheService:
    """
    知识库本地缓存服务

    职责：
    1. 初始化时自动创建 kb_cache 表
    2. 从外部 ChromaDB 同步元数据到本地
    3. 提供只读缓存查询接口
    4. 当外部 KB 完全不可用时，系统降级为"只读缓存模式"
    """

    def __init__(self):
        self._sync_mode = False  # True=已降级为纯缓存模式
        self._init_done = False

    async def ensure_table(self):
        """确保 kb_cache 表已创建（异步）"""
        if self._init_done:
            return
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        self._init_done = True

    async def sync_from_external(
        self,
        external_kb_url: str,
        project_id: str,
        collections: Optional[list[str]] = None,
    ) -> dict:
        """
        从外部 ChromaDB 同步元数据到本地 kb_cache 表

        Args:
            external_kb_url: 外部 ChromaDB 服务地址，如 http://localhost:8001
            project_id: 项目 ID
            collections: 要同步的 collection 列表，None 表示全部

        Returns:
            同步结果统计 {"synced": n, "failed": n, "skipped": n}
        """
        await self.ensure_table()
        results = {"synced": 0, "failed": 0, "skipped": 0}

        async def _notify(event_type: str, **extra: object) -> None:
            try:
                from backend.routes.kb_sse import notify_kb_event

                await notify_kb_event(event_type, source="kb_cache", **extra)
            except Exception:
                pass

        try:
            import httpx
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(f"{external_kb_url}/api/v1/collections")
                resp.raise_for_status()
                collections_data = resp.json()
                ref_map: dict[str, tuple[str, str]] = {}
                for item in collections_data:
                    if not isinstance(item, dict):
                        continue
                    name = str(item.get("name") or item.get("id") or "").strip()
                    ref = str(item.get("id") or item.get("name") or "").strip()
                    if not name or not ref:
                        continue
                    ref_map[name] = (name, ref)
                    ref_map[ref] = (name, ref)

                if collections is None:
                    collections = list(
                        {
                            pair[0]: pair[1]
                            for pair in ref_map.values()
                        }.keys()
                    )
                else:
                    pass  # 使用传入的 collections 列表

                for col_name in collections:
                    try:
                        display_name, collection_ref = ref_map.get(str(col_name), (str(col_name), str(col_name)))
                        if collection_ref == display_name and display_name not in ref_map:
                            results["skipped"] += 1
                            continue

                        get_resp = await client.post(
                            f"{external_kb_url}/api/v1/collections/{collection_ref}/get",
                            json={
                                "limit": 10000,
                                "offset": 0,
                                "include": ["metadatas", "documents"],
                            },
                        )
                        get_resp.raise_for_status()
                        query_data = get_resp.json()

                        docs_raw = query_data.get("documents") or []
                        metas_raw = query_data.get("metadatas") or []
                        if docs_raw and isinstance(docs_raw[0], list):
                            docs_list: list = docs_raw[0]
                        else:
                            docs_list = docs_raw if isinstance(docs_raw, list) else []
                        if metas_raw and isinstance(metas_raw[0], list):
                            metas_list: list = metas_raw[0]
                        else:
                            metas_list = metas_raw if isinstance(metas_raw, list) else []

                        # 逐条写入本地缓存
                        async with async_session_maker() as db:
                            for i, doc in enumerate(docs_list):
                                metadata = (metas_list[i] if i < len(metas_list) else {}) or {}
                                if not isinstance(metadata, dict):
                                    metadata = {}
                                metadata = normalize_kb_metadata_dict(metadata)
                                entry_id = metadata.get("id") or str(uuid.uuid4())

                                existing = await db.execute(
                                    select(KBCache).where(
                                        KBCache.id == entry_id,
                                        KBCache.project_id == project_id,
                                    )
                                )
                                existing_entry = existing.scalar_one_or_none()

                                now = datetime.now().isoformat()
                                if existing_entry:
                                    existing_entry.content = doc
                                    existing_entry.metadata_ = json.dumps(metadata)
                                    existing_entry.updated_at = now
                                    existing_entry.sync_status = "synced"
                                else:
                                    new_entry = KBCache(
                                        id=entry_id,
                                        project_id=project_id,
                                        collection=display_name,
                                        content=doc,
                                        metadata_=json.dumps(metadata),
                                        source=metadata.get("source", ""),
                                        created_at=now,
                                        updated_at=now,
                                        sync_status="synced",
                                        reliability=0.8,
                                        version=1,
                                    )
                                    db.add(new_entry)
                                results["synced"] += 1
                            await db.commit()
                    except Exception:
                        results["failed"] += 1
        except Exception:
            # 外部 KB 不可用，降级为纯缓存模式
            self._sync_mode = True
            await _notify("query_fallback", project_id=project_id, data={"phase": "sync_failed"})
            return results

        # 同步成功：清除「仅缓存」粘性标记，并广播完成事件
        self._sync_mode = False
        await _notify(
            "sync_complete",
            project_id=project_id,
            data={"synced": results["synced"], "failed": results["failed"], "skipped": results["skipped"]},
        )
        return results

    async def upsert_cache_chunks(
        self,
        *,
        project_id: str,
        collection: str,
        items: list[dict[str, Any]],
    ) -> int:
        """
        将指定 chunk 列表写入 kb_cache（对话收割等增量场景，避免全库 sync）。
        每项需含 id、content、metadata（dict）。
        """
        if not items:
            return 0
        await self.ensure_table()
        pid = str(project_id).strip() or "__all__"
        col = str(collection).strip()
        now = datetime.now().isoformat()
        written = 0

        async def _notify(event_type: str, **extra: object) -> None:
            try:
                from backend.routes.kb_sse import notify_kb_event

                await notify_kb_event(event_type, source="kb_cache", **extra)
            except Exception:
                pass

        async with async_session_maker() as db:
            for raw in items:
                chunk_id = str(raw.get("id") or "").strip()
                if not chunk_id:
                    continue
                content = str(raw.get("content") or "")
                metadata = normalize_kb_metadata_dict(
                    raw.get("metadata") if isinstance(raw.get("metadata"), dict) else {}
                )
                entry_id = str(metadata.get("id") or chunk_id)
                existing = await db.execute(
                    select(KBCache).where(
                        KBCache.id == entry_id,
                        KBCache.project_id == pid,
                    )
                )
                row = existing.scalar_one_or_none()
                source = str(metadata.get("source") or "")
                if row:
                    row.content = content
                    row.collection = col
                    row.metadata_ = json.dumps(metadata, ensure_ascii=False)
                    row.source = source
                    row.updated_at = now
                    row.sync_status = "synced"
                else:
                    db.add(
                        KBCache(
                            id=entry_id,
                            project_id=pid,
                            collection=col,
                            content=content,
                            metadata_=json.dumps(metadata, ensure_ascii=False),
                            source=source,
                            created_at=now,
                            updated_at=now,
                            sync_status="synced",
                            reliability=0.8,
                            version=1,
                        )
                    )
                written += 1
            await db.commit()

        if written:
            await _notify(
                "sync_complete",
                project_id=pid,
                data={"synced": written, "failed": 0, "skipped": 0, "incremental": True},
            )
        return written

    async def get_cached_entries(
        self,
        project_id: str,
        collection: Optional[str] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict]:
        """
        按 project_id 读取本地 kb_cache 缓存条目

        Args:
            project_id: 项目 ID；若为 ``__all__``、``*`` 或 ``all`` 则不按项目过滤（全量浏览）。
            collection: 可选，按 collection 过滤
            limit: 返回条数上限
            offset: 翻页偏移

        Returns:
            缓存条目列表，每条包含 id, collection, content, metadata, source, reliability 等
        """
        await self.ensure_table()
        async with async_session_maker() as db:
            query = select(KBCache)
            if project_id not in ALL_PROJECT_IDS:
                query = query.where(KBCache.project_id == project_id)
            if collection:
                query = query.where(KBCache.collection == collection)
            query = query.order_by(KBCache.reliability.desc(), KBCache.updated_at.desc())
            query = query.limit(limit).offset(offset)

            result = await db.execute(query)
            entries = result.scalars().all()

            return [
                {
                    "id": e.id,
                    "project_id": e.project_id,
                    "collection": e.collection,
                    "content": e.content,
                    "metadata": normalize_kb_metadata_dict(
                        json.loads(e.metadata_) if e.metadata_ else {}
                    ),
                    "source": e.source,
                    "reliability": e.reliability,
                    "created_at": e.created_at,
                    "updated_at": e.updated_at,
                }
                for e in entries
            ]

    async def get_cached_entry_by_id(self, entry_id: str) -> dict | None:
        """按主键 id 取单条（kb_cache.id 全局唯一）。"""
        await self.ensure_table()
        async with async_session_maker() as db:
            row = await db.get(KBCache, entry_id)
            if not row:
                return None
            e = row
            return {
                "id": e.id,
                "project_id": e.project_id,
                "collection": e.collection,
                "content": e.content,
                "metadata": normalize_kb_metadata_dict(
                    json.loads(e.metadata_) if e.metadata_ else {}
                ),
                "source": e.source,
                "reliability": e.reliability,
                "created_at": e.created_at,
                "updated_at": e.updated_at,
            }

    async def get_cache_stats(self, project_id: str) -> dict:
        """获取项目缓存统计信息"""
        await self.ensure_table()
        async with async_session_maker() as db:
            query = select(KBCache)
            if project_id not in ALL_PROJECT_IDS:
                query = query.where(KBCache.project_id == project_id)
            result = await db.execute(query)
            entries = result.scalars().all()

        collections_set = {e.collection for e in entries if e.collection}
        total = len(entries)
        synced = sum(1 for e in entries if e.sync_status == "synced")
        return {
            "project_id": project_id,
            "total_entries": total,
            "synced_entries": synced,
            "collections": sorted(collections_set),
            "readonly_mode": self._sync_mode,
        }


# 全局单例
kb_cache_service = KBCacheService()
