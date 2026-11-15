"""项目包中的 session：对话、场景、共创、头脑风暴各为一条独立子任务。"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Column, String, UniqueConstraint

from backend.db import Base


class ProjectSession(Base):
    __tablename__ = "project_sessions"
    __table_args__ = (
        UniqueConstraint("project_id", "kind", "source_id", name="uq_project_session_source"),
    )

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = Column(String, nullable=False, index=True)
    kind = Column(String, nullable=False)  # dialogue | scene | cocreate | brainstorm
    title = Column(String, nullable=False, default="")
    source_kind = Column(String, nullable=False, default="")
    source_id = Column(String, nullable=False)
    owner_id = Column(String, nullable=False, default="default")
    created_at = Column(String, default=lambda: datetime.now().isoformat())
    updated_at = Column(String, default=lambda: datetime.now().isoformat())
