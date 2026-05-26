from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Column, String, Text

from backend.db import Base


class FeedbackEvent(Base):
    """用户对助手回复的结构化反馈。"""

    __tablename__ = "feedback_events"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String, default="default", nullable=False)
    channel = Column(String, default="web", nullable=False)
    session_id = Column(String)
    message_id = Column(String)
    run_id = Column(String)
    output_id = Column(String)
    project_id = Column(String)
    scenario_id = Column(String)
    adoption_level = Column(String, nullable=False)  # full | partial | reject | unknown
    reaction_type = Column(String)  # thumbs_up | thumbs_down | adopt | rewrite
    reason_text = Column(Text)
    source_excerpt = Column(Text)
    memory_line = Column(Text)
    created_at = Column(String, default=lambda: datetime.now().isoformat())
