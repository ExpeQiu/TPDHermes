"""知识库导入任务记录。"""

import uuid
from datetime import datetime

from sqlalchemy import Column, String, Text

from backend.db import Base


class KbIngestJob(Base):
    __tablename__ = "kb_ingest_jobs"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    source_type = Column(String(32), nullable=False, default="manifest")
    collection = Column(String(512), nullable=False)
    status = Column(String(32), nullable=False, default="queued")
    payload_json = Column(Text, nullable=False, default="{}")
    result_json = Column(Text, nullable=True)
    created_at = Column(String, default=lambda: datetime.now().isoformat())
    updated_at = Column(String, default=lambda: datetime.now().isoformat())
    created_by = Column(String, nullable=True)
