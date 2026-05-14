from __future__ import annotations

from datetime import datetime

from sqlalchemy import Column, ForeignKey, String, Text

from backend.db import Base


class ProjectConfig(Base):
    """项目级默认编排策略缓存。"""

    __tablename__ = "project_configs"

    project_id = Column(String, ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True)
    defaults_json = Column(Text, nullable=False, default="{}")
    updated_at = Column(String, default=lambda: datetime.now().isoformat())
