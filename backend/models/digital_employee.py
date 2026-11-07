"""数字员工：档案、能力绑定、项目钉选、钥匙与飞书入站。"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Column, Integer, String, Text, UniqueConstraint

from backend.db import Base


def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _now() -> str:
    return datetime.now().isoformat()


class DigitalEmployee(Base):
    __tablename__ = "digital_employees"
    __table_args__ = (UniqueConstraint("name", name="uq_digital_employee_name"),)

    id = Column(String, primary_key=True, default=lambda: _id("emp"))
    name = Column(String, nullable=False)
    role_name = Column(String, nullable=False, default="待补充")
    description = Column(Text, default="")
    persona_prompt = Column(Text, default="")
    onboarded_at = Column(String, default="")
    work_styles_json = Column(Text, nullable=False, default="[]")
    expertise_json = Column(Text, nullable=False, default="[]")
    work_modes_json = Column(Text, nullable=False, default="[]")
    status = Column(String, nullable=False, default="active")  # active|archived
    published_to_gallery = Column(Integer, nullable=False, default=0)
    owner_user_id = Column(String, nullable=False, default="default")
    owner_name = Column(String, nullable=False, default="")
    scenario_id = Column(String, default="")
    scenario_version = Column(String, default="")
    pack_id = Column(String, default="")
    unpublished_at = Column(String, default="")
    unpublished_by = Column(String, default="")
    created_at = Column(String, default=_now)
    updated_at = Column(String, default=_now)


class EmployeeResourceBinding(Base):
    __tablename__ = "employee_resource_bindings"
    __table_args__ = (
        UniqueConstraint(
            "employee_id",
            "resource_type",
            "resource_id",
            name="uq_employee_resource",
        ),
    )

    id = Column(String, primary_key=True, default=lambda: _id("ebind"))
    employee_id = Column(String, nullable=False, index=True)
    resource_type = Column(String, nullable=False)  # scenario|skill|knowledge|template|pack
    resource_id = Column(String, nullable=False)
    resource_version = Column(String, nullable=False, default="")
    status = Column(String, nullable=False, default="active")  # active|inactive|deleted
    internal = Column(Integer, nullable=False, default=0)
    created_at = Column(String, default=_now)
    updated_at = Column(String, default=_now)


class EmployeeUsage(Base):
    __tablename__ = "employee_usages"
    __table_args__ = (UniqueConstraint("employee_id", "user_id", name="uq_employee_usage"),)

    id = Column(String, primary_key=True, default=lambda: _id("euse"))
    employee_id = Column(String, nullable=False, index=True)
    user_id = Column(String, nullable=False, index=True)
    created_at = Column(String, default=_now)


class ProjectEmployee(Base):
    __tablename__ = "project_employees"
    __table_args__ = (UniqueConstraint("project_id", "employee_id", name="uq_project_employee"),)

    id = Column(String, primary_key=True, default=lambda: _id("pemp"))
    project_id = Column(String, nullable=False, index=True)
    employee_id = Column(String, nullable=False, index=True)
    enabled = Column(Integer, nullable=False, default=1)
    created_at = Column(String, default=_now)


class EmployeeCredential(Base):
    __tablename__ = "employee_credentials"

    id = Column(String, primary_key=True, default=lambda: _id("ekey"))
    kind = Column(String, nullable=False)  # account|employee
    owner_user_id = Column(String, nullable=False, index=True)
    employee_id = Column(String, default="")
    prefix = Column(String, nullable=False, default="")
    token_hash = Column(String, nullable=False)
    expires_at = Column(String, nullable=False)
    revoked_at = Column(String, default="")
    created_at = Column(String, default=_now)


class FeishuEmployeeBinding(Base):
    __tablename__ = "feishu_employee_bindings"

    id = Column(String, primary_key=True, default=lambda: _id("fbind"))
    app_id = Column(String, nullable=False, default="")
    employee_id = Column(String, nullable=False, index=True)
    status = Column(String, nullable=False, default="active")
    created_at = Column(String, default=_now)


class FeishuUserLink(Base):
    __tablename__ = "feishu_user_links"
    __table_args__ = (UniqueConstraint("channel_user_id", name="uq_feishu_channel_user"),)

    id = Column(String, primary_key=True, default=lambda: _id("flink"))
    channel_user_id = Column(String, nullable=False)
    local_user_id = Column(String, nullable=False, index=True)
    created_at = Column(String, default=_now)


class ConfirmationStep(Base):
    """知识治理或共创评审的确认步骤。失败不改 plan_json。"""

    __tablename__ = "confirmation_steps"

    id = Column(String, primary_key=True, default=lambda: _id("cstep"))
    subject_type = Column(String, nullable=False)  # govern|co_create
    subject_id = Column(String, nullable=False, default="")
    employee_id = Column(String, default="")
    status = Column(String, nullable=False, default="pending")
    plan_json = Column(Text, nullable=False, default="{}")
    note = Column(Text, default="")
    actor_user_id = Column(String, default="")
    created_at = Column(String, default=_now)
    updated_at = Column(String, default=_now)


class FeishuInboundEvent(Base):
    __tablename__ = "feishu_inbound_events"
    __table_args__ = (UniqueConstraint("event_id", name="uq_feishu_inbound_event"),)

    id = Column(String, primary_key=True, default=lambda: _id("fin"))
    event_id = Column(String, nullable=False)
    employee_id = Column(String, nullable=False)
    user_id = Column(String, nullable=False, default="")
    run_id = Column(String, default="")
    attempts = Column(Integer, nullable=False, default=0)
    last_error = Column(Text, default="")
    created_at = Column(String, default=_now)
