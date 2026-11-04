"""本机账号：用户名密码注册，会话令牌绑定统一 User ID。"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Column, String

from backend.db import Base


class LocalAccount(Base):
    __tablename__ = "local_accounts"

    username = Column(String, primary_key=True)
    user_id = Column(String, nullable=False, unique=True)
    display_name = Column(String, nullable=False)
    employee_id = Column(String, nullable=True)
    org_id = Column(String, nullable=True)
    password_hash = Column(String, nullable=False)
    created_at = Column(String, default=lambda: datetime.now().isoformat())
