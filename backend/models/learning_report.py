from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Column, String, Text

from backend.db import Base


class LearningReport(Base):
    """周期性学习摘要快照。"""

    __tablename__ = "learning_reports"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String, default="default")
    week_start = Column(String, nullable=False)
    summary_json = Column(Text, nullable=False)
    created_at = Column(String, default=lambda: datetime.now().isoformat())
