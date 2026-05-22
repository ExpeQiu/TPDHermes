from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Column, String, Text

from backend.db import Base


class UsageEvent(Base):
    """前端功能使用埋点明细。"""

    __tablename__ = "usage_events"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    event_name = Column(String, nullable=False)
    feature = Column(String)
    action = Column(String)
    user_id = Column(String, default="default")
    session_id = Column(String)
    page_path = Column(String)
    project_id = Column(String)
    event_time = Column(String, default=lambda: datetime.now().isoformat())
    properties_json = Column(Text)
    created_at = Column(String, default=lambda: datetime.now().isoformat())
