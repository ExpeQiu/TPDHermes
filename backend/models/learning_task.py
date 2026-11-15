"""夜跑学习计划任务：一条缺陷一条任务，验收后关闭或回滚。"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Column, String, Text

from backend.db import Base


class LearningTask(Base):
    __tablename__ = "learning_tasks"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    dedupe_key = Column(String, nullable=False, index=True)
    kind = Column(String, nullable=False)
    status = Column(String, nullable=False, default="confirmed")
    target_kind = Column(String)
    target_id = Column(String)
    summary = Column(Text)
    signal_type = Column(String)
    rule_id = Column(String)
    baseline_json = Column(Text)
    acceptance_json = Column(Text)
    evidence_json = Column(Text)
    payload_json = Column(Text)
    due_at = Column(String)
    parent_id = Column(String)
    night_key = Column(String)
    created_at = Column(String, default=lambda: datetime.now().isoformat())
    updated_at = Column(String, default=lambda: datetime.now().isoformat())
