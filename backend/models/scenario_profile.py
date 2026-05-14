from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Column, String, Text

from backend.db import Base


class ScenarioProfile(Base):
    """场景编排定义（可版本化、可发布）。"""

    __tablename__ = "scenario_profiles"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    code = Column(String, unique=True, nullable=False)
    name = Column(String, nullable=False)
    description = Column(Text)
    category = Column(String)
    goal = Column(Text)
    conversation_mode = Column(String, nullable=False, default="task_oriented")
    domain_json = Column(Text, nullable=False, default="{}")
    knowledge_policy_json = Column(Text, nullable=False, default="{}")
    skills_policy_json = Column(Text, nullable=False, default="{}")
    output_policy_json = Column(Text, nullable=False, default="{}")
    preset_instructions = Column(Text)
    opening_hint = Column(Text)
    version = Column(String, nullable=False, default="1.0.0")
    status = Column(String, nullable=False, default="draft")  # draft|published|disabled
    created_by = Column(String)
    created_at = Column(String, default=lambda: datetime.now().isoformat())
    updated_at = Column(String, default=lambda: datetime.now().isoformat())
