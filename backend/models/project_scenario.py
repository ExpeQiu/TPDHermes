from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Column, ForeignKey, Integer, String, UniqueConstraint

from backend.db import Base


class ProjectScenario(Base):
    """项目与场景的绑定（含钉选版本）。"""

    __tablename__ = "project_scenarios"
    __table_args__ = (UniqueConstraint("project_id", "scenario_id", name="uq_project_scenario"),)

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = Column(String, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    scenario_id = Column(String, ForeignKey("scenario_profiles.id", ondelete="CASCADE"), nullable=False)
    scenario_version = Column(String, nullable=False)
    is_default = Column(Integer, nullable=False, default=0)
    enabled = Column(Integer, nullable=False, default=1)
    created_at = Column(String, default=lambda: datetime.now().isoformat())
    updated_at = Column(String, default=lambda: datetime.now().isoformat())
