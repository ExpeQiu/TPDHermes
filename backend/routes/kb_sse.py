"""
知识库变更 SSE 通知 (M2-T03)

提供 SSE 端点，客户端可订阅知识库变更事件。
当 KB 同步完成或查询结果来源变更时，主动推送通知。

端点：
  GET  /kb/events                    - SSE 订阅端点
  POST /kb/events/publish             - 手动触发一条 KB 事件（内部广播）
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime
from typing import Any, AsyncGenerator, Dict, Optional

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

router = APIRouter(prefix="/kb", tags=["knowledge_base"])


# ═══════════════════════════════════════════════════════════════
# 全局订阅管理器
# ═══════════════════════════════════════════════════════════════

class KBEvent:
    """KB 事件对象"""

    def __init__(
        self,
        event_type: str,
        project_id: Optional[str] = None,
        collection: Optional[str] = None,
        data: Optional[Dict[str, Any]] = None,
        source: str = "system",
    ):
        self.event_type = event_type  # sync_complete | query_fallback | entry_added | entry_updated
        self.project_id = project_id
        self.collection = collection
        self.data = data or {}
        self.source = source
        self.timestamp = datetime.now().isoformat()

    def to_dict(self) -> dict:
        d = {
            "type": self.event_type,
            "event_type": self.event_type,
            "project_id": self.project_id,
            "collection": self.collection,
            "source": self.source,
            "timestamp": self.timestamp,
            **self.data,
        }
        return d

    def to_sse(self) -> str:
        return f"data: {json.dumps(self.to_dict(), ensure_ascii=False)}\n\n"


class KBSubscriber:
    """
    单个 SSE 客户端订阅者。
    保存 queue 用于推送事件。
    """

    def __init__(self, queue: asyncio.Queue):
        self.queue: asyncio.Queue[KBEvent] = queue
        self.alive = True

    async def send(self, event: KBEvent):
        if self.alive:
            try:
                self.queue.put_nowait(event)
            except Exception:
                pass

    def close(self):
        self.alive = False


class KBSubscriptionManager:
    """
    全局 KB 事件订阅管理器。
    维护活跃订阅者列表，提供广播能力。
    """

    def __init__(self):
        self._subscribers: list[KBSubscriber] = []
        self._lock = asyncio.Lock()

    async def subscribe(self) -> KBSubscriber:
        """注册一个新订阅者"""
        queue: asyncio.Queue[KBEvent] = asyncio.Queue()
        sub = KBSubscriber(queue)
        async with self._lock:
            self._subscribers.append(sub)
        return sub

    async def unsubscribe(self, sub: KBSubscriber):
        """取消订阅"""
        sub.close()
        async with self._lock:
            if sub in self._subscribers:
                self._subscribers.remove(sub)

    async def broadcast(self, event: KBEvent):
        """向所有活跃订阅者广播事件"""
        async with self._lock:
            dead = []
            for sub in self._subscribers:
                if not sub.alive:
                    dead.append(sub)
                else:
                    try:
                        sub.queue.put_nowait(event)
                    except Exception:
                        dead.append(sub)
            for d in dead:
                if d in self._subscribers:
                    self._subscribers.remove(d)

    @property
    def active_count(self) -> int:
        return sum(1 for s in self._subscribers if s.alive)


# 全局单例
_kb_sse_manager = KBSubscriptionManager()


# ═══════════════════════════════════════════════════════════════
# SSE 端点
# ═══════════════════════════════════════════════════════════════

async def _sse_stream(sub: KBSubscriber) -> AsyncGenerator[str, None]:
    """
    持续推送事件直到客户端断开。
    每 25 秒发送一次 keepalive ping。
    """
    yield f"data: {json.dumps({'type': 'connected', 'timestamp': datetime.now().isoformat()}, ensure_ascii=False)}\n\n"

    while sub.alive:
        try:
            # 等待事件，最多 25 秒（keepalive 间隔）
            event = await asyncio.wait_for(sub.queue.get(), timeout=25)
            yield event.to_sse()
        except asyncio.TimeoutError:
            # Keepalive ping
            yield f": keepalive {datetime.now().isoformat()}\n\n"
        except Exception:
            break

    yield f"data: {json.dumps({'type': 'disconnected'}, ensure_ascii=False)}\n\n"


@router.get("/events")
async def kb_events_subscribe(
    project_id: Optional[str] = Query(None, description="限定项目 ID"),
):
    """
    SSE 知识库事件订阅端点。
    GET /kb/events

    客户端保持此连接，即可接收 KB 变更事件。

    支持 Query 参数：
      - project_id: 可选，限定只接收特定项目的事件

    SSE 事件格式：
      - type: connected      - 连接成功
      - type: sync_complete  - 同步完成
      - type: query_fallback - 查询降级到缓存
      - type: entry_added    - 新增条目
      - type: entry_updated  - 更新条目
      - type: disconnected   - 连接断开

    示例：
      curl -N http://localhost:8000/kb/events
    """
    sub = await _kb_sse_manager.subscribe()

    async def filtered_stream():
        try:
            async for line in _sse_stream(sub):
                if project_id:
                    try:
                        data_str = line.split("data: ", 1)[1].strip()
                        evt = json.loads(data_str)
                        if evt.get("project_id") and evt["project_id"] != project_id:
                            continue
                    except Exception:
                        pass
                yield line
        finally:
            await _kb_sse_manager.unsubscribe(sub)

    return StreamingResponse(
        filtered_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ═══════════════════════════════════════════════════════════════
# 手动触发事件（内部调用接口）
# ═══════════════════════════════════════════════════════════════

class PublishEventRequest(BaseModel):
    event_type: str  # sync_complete | query_fallback | entry_added | entry_updated
    project_id: Optional[str] = None
    collection: Optional[str] = None
    source: str = "manual"
    data: Optional[Dict[str, Any]] = None


@router.post("/events/publish")
async def publish_kb_event(req: PublishEventRequest):
    """
    手动触发一条 KB 事件（供内部服务调用，向所有 SSE 订阅者广播）。
    POST /kb/events/publish
    """
    event = KBEvent(
        event_type=req.event_type,
        project_id=req.project_id,
        collection=req.collection,
        source=req.source,
        data=req.data or {},
    )
    await _kb_sse_manager.broadcast(event)
    return {
        "ok": True,
        "active_subscribers": _kb_sse_manager.active_count,
        "event": event.to_dict(),
    }


@router.get("/events/status")
async def kb_events_status():
    """查询 SSE 订阅状态 GET /kb/events/status"""
    return {
        "active_subscribers": _kb_sse_manager.active_count,
    }


# ═══════════════════════════════════════════════════════════════
# 集成到 KB 服务（kb_cache.py / kb_proxy.py 自动触发事件）
# ═══════════════════════════════════════════════════════════════

async def notify_kb_event(
    event_type: str,
    project_id: Optional[str] = None,
    collection: Optional[str] = None,
    source: str = "kb_service",
    **kwargs,
):
    """
    供 kb_cache / kb_proxy 调用的快捷广播函数。
    在相关操作完成后调用此函数，主动推送 SSE 事件。
    """
    event = KBEvent(
        event_type=event_type,
        project_id=project_id,
        collection=collection,
        source=source,
        data=kwargs,
    )
    await _kb_sse_manager.broadcast(event)
