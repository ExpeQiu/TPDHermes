from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Column, String, Text

from backend.db import Base


class ExperienceEntry(Base):
    """TPD 经验库索引层（正文在 Chroma tpd_experience 集合）。"""

    __tablename__ = "experience_entries"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = Column(String)
    scenario_tags_json = Column(Text)
    run_id = Column(String)
    output_id = Column(String)
    feedback_id = Column(String)
    content_summary = Column(Text)
    iteration_of = Column(String)
    valid_until = Column(String)
    published = Column(String, default="false")
    kb_doc_id = Column(String)
    collection_name = Column(String)
    created_at = Column(String, default=lambda: datetime.now().isoformat())
