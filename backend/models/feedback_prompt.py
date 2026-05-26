from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Column, String, Text

from backend.db import Base


class FeedbackPrompt(Base):
    """24h 无反馈时的主动确认队列。"""

    __tablename__ = "feedback_prompts"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    run_id = Column(String, nullable=False)
    output_id = Column(String)
    session_id = Column(String)
    message_id = Column(String)
    project_id = Column(String)
    user_id = Column(String, default="default")
    prompt_status = Column(String, default="pending")  # pending | answered | expired
    prompted_at = Column(String)
    answered_at = Column(String)
    feedback_id = Column(String)
    created_at = Column(String, default=lambda: datetime.now().isoformat())
