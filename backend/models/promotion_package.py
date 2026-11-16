"""技术推广包任务、步骤与审核记录。"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Column, Integer, String, Text, UniqueConstraint

from backend.db import Base


def _now() -> str:
    return datetime.now().isoformat()


class PromotionPackage(Base):
    __tablename__ = "promotion_packages"
    __table_args__ = (
        UniqueConstraint("project_id", "idempotency_key", name="uq_promotion_pkg_idem"),
    )

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = Column(String, nullable=False, index=True)
    idempotency_key = Column(String, nullable=False)
    status = Column(String, nullable=False, default="draft")
    created_by = Column(String, nullable=False)
    product_types_json = Column(Text, nullable=False, default="[]")
    file_refs_json = Column(Text, nullable=False, default="[]")
    snapshot_json = Column(Text, nullable=False, default="[]")
    assessment_json = Column(Text, nullable=False, default="{}")
    brief_json = Column(Text, nullable=False, default="{}")
    facts_json = Column(Text, nullable=False, default="[]")
    products_json = Column(Text, nullable=False, default="{}")
    brief_version = Column(Integer, nullable=False, default=0)
    facts_version = Column(Integer, nullable=False, default=0)
    revision = Column(Integer, nullable=False, default=1)
    error_message = Column(Text, nullable=True)
    created_at = Column(String, default=_now)
    updated_at = Column(String, default=_now)


class PromotionPackageStep(Base):
    __tablename__ = "promotion_package_steps"
    __table_args__ = (
        UniqueConstraint(
            "package_id",
            "step_key",
            "input_version",
            name="uq_promotion_step_input",
        ),
    )

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    package_id = Column(String, nullable=False, index=True)
    project_id = Column(String, nullable=False, index=True)
    step_key = Column(String, nullable=False)
    input_version = Column(String, nullable=False, default="")
    status = Column(String, nullable=False, default="pending")
    attempt = Column(Integer, nullable=False, default=0)
    error_type = Column(String, nullable=True)
    error_message = Column(Text, nullable=True)
    output_id = Column(String, nullable=True)
    worker_id = Column(String, nullable=True)
    lease_until = Column(String, nullable=True)
    started_at = Column(String, nullable=True)
    finished_at = Column(String, nullable=True)
    created_at = Column(String, default=_now)
    updated_at = Column(String, default=_now)


class PromotionPackageReview(Base):
    __tablename__ = "promotion_package_reviews"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    package_id = Column(String, nullable=False, index=True)
    project_id = Column(String, nullable=False, index=True)
    output_id = Column(String, nullable=False)
    output_version = Column(String, nullable=False)
    product = Column(String, nullable=False)
    action = Column(String, nullable=False)
    comment = Column(Text, nullable=False, default="")
    actor_id = Column(String, nullable=False)
    fact_ids_json = Column(Text, nullable=False, default="[]")
    facts_version = Column(Integer, nullable=False, default=0)
    brief_version = Column(Integer, nullable=False, default=0)
    created_at = Column(String, default=_now)
