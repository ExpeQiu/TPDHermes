"""聊天/场景会话持久化（按 user_id 隔离，支持跨设备同步）。"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Column, ForeignKey, Index, Integer, String, Text

from backend.db import Base


class ChatSessionRecord(Base):
    __tablename__ = "chat_sessions"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String, nullable=False, default="default")
    title = Column(String, nullable=False, default="新对话")
    session_kind = Column(String, nullable=False, default="chat")  # chat | scenario
    context_json = Column(Text)
    linked_output_ids_json = Column(Text)
    linked_run_ids_json = Column(Text)
    created_at_ms = Column(Integer, nullable=False, default=lambda: int(datetime.now().timestamp() * 1000))
    updated_at = Column(String, default=lambda: datetime.now().isoformat())
    created_at = Column(String, default=lambda: datetime.now().isoformat())


class ChatMessageRecord(Base):
    __tablename__ = "chat_messages"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    session_id = Column(String, ForeignKey("chat_sessions.id", ondelete="CASCADE"), nullable=False)
    role = Column(String, nullable=False)
    content = Column(Text, nullable=False, default="")
    metadata_json = Column(Text)
    sort_index = Column(Integer, nullable=False, default=0)
    created_at = Column(String, default=lambda: datetime.now().isoformat())


Index("idx_chat_sessions_user_updated", ChatSessionRecord.user_id, ChatSessionRecord.updated_at)
Index("idx_chat_messages_session_sort", ChatMessageRecord.session_id, ChatMessageRecord.sort_index)
