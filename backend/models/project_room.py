"""项目共创群聊：一场对话共享给项目成员，不按 user_id 隔离。"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Column, Index, Integer, String, Text, UniqueConstraint, text

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
    archived_at = Column(String)
    seq_counter = Column(Integer, nullable=False, default=0)
    event_counter = Column(Integer, nullable=False, default=0)
    plan_id = Column(String)
    plan_version = Column(Integer, nullable=False, default=0)
    plan_summary = Column(Text, nullable=False, default="")
    plan_confirmed_version = Column(Integer)
    plan_confirmed_by = Column(String)
    lease_until = Column(String)
    turn_retry = Column(Integer, nullable=False, default=0)
    created_at = Column(String, default=lambda: datetime.now().isoformat())
    updated_at = Column(String, default=lambda: datetime.now().isoformat())


class ProjectRoomMessage(Base):
    __tablename__ = "project_room_messages"
    __table_args__ = (
        UniqueConstraint("room_id", "seq", name="uq_project_room_messages_room_seq"),
        Index("idx_project_room_messages_room_seq", "room_id", "seq"),
        Index("idx_project_room_messages_room_event", "room_id", "event_seq"),
        Index(
            "uq_room_client_message",
            "room_id",
            "author_id",
            "client_message_id",
            unique=True,
            sqlite_where=text("client_message_id IS NOT NULL AND client_message_id != ''"),
        ),
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
    agent_mode = Column(String, nullable=False, default="agent")  # ask | agent | plan
    turn_state = Column(String, nullable=False, default="done")  # queued | running | succeeded | failed | cancelled；done 仅旧数据
    client_message_id = Column(String)
    event_seq = Column(Integer, nullable=False, default=0)
    error_summary = Column(Text, nullable=False, default="")
    error_code = Column(Integer)
    materials_json = Column(Text, nullable=False, default="[]")
    warnings_json = Column(Text, nullable=False, default="[]")
    run_id = Column(String)
    plan_id = Column(String)
    plan_version = Column(Integer)
    created_at = Column(String, default=lambda: datetime.now().isoformat())
