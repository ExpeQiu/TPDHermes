from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Column, String, Text

from backend.db import Base


class LearningSignal(Base):
    """学习决策层探测到的待处理信号。"""

    __tablename__ = "learning_signals"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    signal_type = Column(String, nullable=False)
    entity_kind = Column(String, nullable=False)
    entity_id = Column(String)
    entity_label = Column(String)
    count = Column(String, default="1")
    status = Column(String, default="open")  # open | ack | dismissed
    payload_json = Column(Text)
    user_id = Column(String, default="default")
    project_id = Column(String)
    last_seen_at = Column(String, default=lambda: datetime.now().isoformat())
    created_at = Column(String, default=lambda: datetime.now().isoformat())
