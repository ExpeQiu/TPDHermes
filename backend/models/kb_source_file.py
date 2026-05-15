"""知识库上传源文件元数据。"""

import uuid
from datetime import datetime

from sqlalchemy import Column, Integer, String, Text

from backend.db import Base


class KbSourceFile(Base):
    __tablename__ = "kb_source_files"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    file_name = Column(Text, nullable=False)
    stored_path = Column(Text, nullable=False)
    checksum = Column(String(128), nullable=True)
    mime_type = Column(String(255), nullable=True)
    size = Column(Integer, nullable=False, default=0)
    doc_id_hint = Column(Text, nullable=True)
    created_at = Column(String, default=lambda: datetime.now().isoformat())
