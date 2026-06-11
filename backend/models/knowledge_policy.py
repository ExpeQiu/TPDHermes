from sqlalchemy import Column, String, Text

from backend.db import Base
import uuid
from datetime import datetime


class KnowledgePolicy(Base):
    __tablename__ = "knowledge_policies"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    code = Column(String, unique=True, nullable=False)
    name = Column(String, nullable=False)
    description = Column(Text)
    config_json = Column(Text, nullable=False, default="{}")
    version = Column(String, nullable=False, default="0.0.1")
    status = Column(String, nullable=False, default="draft")
    created_by = Column(String)
    approved_by = Column(String)
    published_by = Column(String)
    offlined_by = Column(String)
    created_at = Column(String, default=lambda: datetime.now().isoformat())
    updated_at = Column(String, default=lambda: datetime.now().isoformat())
    approved_at = Column(String)
    published_at = Column(String)
    offlined_at = Column(String)
