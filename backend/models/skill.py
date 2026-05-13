from sqlalchemy import Column, String, Text, Integer
from backend.models.project import Base
import uuid
from datetime import datetime


class Skill(Base):
    __tablename__ = "skills"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    name = Column(String, nullable=False, unique=True)
    description = Column(Text)
    config = Column(Text, default="{}")       # JSON 配置
    version = Column(String, default="1.0.0")
    enabled = Column(Integer, default=1)        # 0=禁用, 1=启用
    source = Column(String, default="local")   # local | marketplace
    installed_at = Column(String, default=lambda: datetime.now().isoformat())
    updated_at = Column(String, default=lambda: datetime.now().isoformat())

    # 版本历史（JSON 数组，每个元素 {version, changelog, installed_at}）
    version_history = Column(Text, default="[]")
