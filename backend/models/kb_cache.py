from sqlalchemy import Column, String, Text, Float, Integer
from backend.db import Base


class KBCache(Base):
    """本地 SQLite KB 缓存表，存储从外部 ChromaDB 同步的知识库条目"""
    __tablename__ = "kb_cache"

    id = Column(String, primary_key=True)
    project_id = Column(String, nullable=False, index=True)
    collection = Column(String, nullable=False, index=True)
    content = Column(Text, nullable=False)
    embedding = Column(Text)  # JSON string, optional
    metadata_ = Column(Text, name="metadata", default="{}")  # JSON string
    source = Column(String)  # 文档来源
    created_at = Column(String)
    updated_at = Column(String)
    # 同步状态: synced, pending, failed
    sync_status = Column(String, default="pending")
    # 可靠性评分 0.0-1.0
    reliability = Column(Float, default=0.5)
    # 版本号，用于增量同步
    version = Column(Integer, default=1)
