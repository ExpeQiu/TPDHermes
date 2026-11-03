"""项目共创群聊：一场对话共享给项目成员，不按 user_id 隔离。"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Column, Index, Integer, String, Text, UniqueConstraint

from backend.db import Base


class ProjectRoom(Base):
    __tablename__ = "project_rooms"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = Column(String, nullable=False, index=True)
    title = Column(String, nullable=False, default="共创对话")
    created_by = Column(String, nullable=False)
    role_ids_json = Column(Text, nullable=False, default="[]")
    writer_role_id = Column(String, nullable=False, default="")
    output_id = Column(String)
    doc_version = Column(Integer, nullable=False, default=0)
    active_turn_id = Column(String)
    created_at = Column(String, default=lambda: datetime.now().isoformat())
    updated_at = Column(String, default=lambda: datetime.now().isoformat())


class ProjectRoomMessage(Base):
    __tablename__ = "project_room_messages"
    __table_args__ = (
        UniqueConstraint("room_id", "seq", name="uq_project_room_messages_room_seq"),
        Index("idx_project_room_messages_room_seq", "room_id", "seq"),
    )

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    room_id = Column(String, nullable=False)
    seq = Column(Integer, nullable=False)
    turn_id = Column(String, nullable=False)
    author_type = Column(String, nullable=False)  # human | agent
    author_id = Column(String, nullable=False)
    author_name = Column(String, nullable=False, default="")
    content = Column(Text, nullable=False, default="")
    mention_role_ids_json = Column(Text, nullable=False, default="[]")
    mention_user_ids_json = Column(Text, nullable=False, default="[]")
    mention_file_ids_json = Column(Text, nullable=False, default="[]")
    file_actions_json = Column(Text, nullable=False, default="[]")
    turn_state = Column(String, nullable=False, default="done")  # queued | running | done
    created_at = Column(String, default=lambda: datetime.now().isoformat())
