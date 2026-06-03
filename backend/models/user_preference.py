"""用户偏好（统一 User ID 等跨设备配置）。"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Column, String, Text

from backend.db import Base


class UserPreference(Base):
    __tablename__ = "user_preferences"

    user_id = Column(String, primary_key=True)
    preferences_json = Column(Text, nullable=False, default="{}")
    updated_at = Column(String, default=lambda: datetime.now().isoformat())
