from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Column, String, Text

from backend.db import Base


class Template(Base):
    __tablename__ = "templates"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    name = Column(String, nullable=False)
    content = Column(Text, nullable=False)
    version = Column(String, nullable=False, default="1.0.0")
    category = Column(String)
    schema_json = Column(Text)  # JSON: required_sections, format, citation_policy, etc.
    format = Column(String, default="markdown")
    validation_rules = Column(Text)  # JSON string
    status = Column(String, default="active")
    created_at = Column(String, default=lambda: datetime.now().isoformat())
    updated_at = Column(String, default=lambda: datetime.now().isoformat())
