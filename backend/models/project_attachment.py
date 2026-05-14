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
