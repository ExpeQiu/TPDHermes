from sqlalchemy import Column, String, Text
from backend.db import Base
import uuid
from datetime import datetime


class Project(Base):
    __tablename__ = "projects"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    name = Column(String, nullable=False)
    description = Column(Text)
    background = Column(Text)
    audience = Column(Text)
    deadline = Column(String)  # ISO8601
    constraints = Column(Text)  # JSON string stored as Text
    status = Column(String, default="active")
    domain_profile_id = Column(String)
    knowledge_policy_id = Column(String)
    default_template_id = Column(String)
    scenario_profile_id = Column(String)
    created_at = Column(String, default=lambda: datetime.now().isoformat())
    updated_at = Column(String, default=lambda: datetime.now().isoformat())
