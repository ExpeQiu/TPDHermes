from sqlalchemy import Column, String, Text

from backend.db import Base
import uuid
from datetime import datetime


class KnowledgePolicyVersion(Base):
    __tablename__ = "knowledge_policy_versions"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    policy_id = Column(String, nullable=False, index=True)
    version = Column(String, nullable=False)
    status = Column(String, nullable=False, default="draft")
    snapshot_json = Column(Text, nullable=False, default="{}")
    change_note = Column(Text)
    created_by = Column(String)
    created_at = Column(String, default=lambda: datetime.now().isoformat())
