"""项目附件：元数据存库，二进制存本地目录。"""

import uuid
from datetime import datetime

from sqlalchemy import Column, ForeignKey, Integer, String, Text

from backend.db import Base


class ProjectAttachment(Base):
    __tablename__ = "project_attachments"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = Column(String, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False, index=True)
    original_filename = Column(Text, nullable=False)
    content_type = Column(String(255))
    size_bytes = Column(Integer, nullable=False)
    stored_path = Column(Text, nullable=False)
    created_at = Column(String, default=lambda: datetime.now().isoformat())
    ingest_status = Column(String, default="pending")
    kb_collection = Column(String)
    kb_doc_id = Column(String)
    chunk_count = Column(Integer)
    ingest_error = Column(Text)
    ingested_at = Column(String)
