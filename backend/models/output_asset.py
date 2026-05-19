from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Column, ForeignKey, String, Text

from backend.db import Base


class OutputAsset(Base):
    """项目产出物 outputs 表。"""

    __tablename__ = "outputs"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = Column(String, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    scenario_id = Column(String)
    template_id = Column(String, ForeignKey("templates.id", ondelete="SET NULL"))
    run_id = Column(String, ForeignKey("orchestration_runs.id", ondelete="SET NULL"))
    title = Column(String)
    summary = Column(Text)
    content = Column(Text, nullable=False)
    content_format = Column(String, default="markdown")
    version = Column(String, default="1")
    status = Column(String, nullable=False, default="draft")
    citations_json = Column(Text)
    owner_id = Column(String, default="default")
    created_at = Column(String, default=lambda: datetime.now().isoformat())
    updated_at = Column(String, default=lambda: datetime.now().isoformat())
