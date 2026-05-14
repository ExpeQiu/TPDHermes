from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Column, ForeignKey, Integer, String, Text

from backend.db import Base


class OrchestrationRun(Base):
    """单次编排执行记录。"""

    __tablename__ = "orchestration_runs"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = Column(String, ForeignKey("projects.id", ondelete="SET NULL"))
    entrypoint = Column(String, nullable=False)
    status = Column(String, nullable=False, default="running")  # running|completed|failed|draft
    request_json = Column(Text)
    snapshot_json = Column(Text)
    response_metadata_json = Column(Text)
    assistant_content = Column(Text)
    validation_json = Column(Text)
    skills_policy_json = Column(Text)
    error_message = Column(Text)
    duration_ms = Column(Integer)
    created_at = Column(String, default=lambda: datetime.now().isoformat())
    updated_at = Column(String, default=lambda: datetime.now().isoformat())
