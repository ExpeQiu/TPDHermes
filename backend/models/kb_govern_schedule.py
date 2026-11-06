from datetime import datetime

from sqlalchemy import Boolean, Column, Integer, String, Text

from backend.db import Base

SCHEDULE_ROW_ID = "default"


class KbGovernSchedule(Base):
    """知识库定时治理的页面配置。有行之后以本表为准。"""

    __tablename__ = "kb_govern_schedule"

    id = Column(String, primary_key=True, default=SCHEDULE_ROW_ID)
    enabled = Column(Boolean, nullable=False, default=False)
    interval_seconds = Column(Integer, nullable=False, default=86400)
    agent_batch = Column(Integer, nullable=False, default=20)
    cadence = Column(String, nullable=False, default="daily")
    run_time = Column(String, nullable=False, default="02:00")
    weekday = Column(Integer, nullable=False, default=0)
    month_day = Column(Integer, nullable=False, default=1)
    policy_ids_json = Column(Text, nullable=False, default="[]")
    last_run_at = Column(String)
    updated_at = Column(String, default=lambda: datetime.now().isoformat())
