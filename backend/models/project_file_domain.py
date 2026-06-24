"""项目文件域中期模型（outputs/attachments 之上的统一抽象）。"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Column, ForeignKey, String, Text

from backend.db import Base


class ProjectFile(Base):
    __tablename__ = "project_files"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = Column(String, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    source_kind = Column(String, nullable=False)  # output | attachment | native
    source_id = Column(String, nullable=False)
    title = Column(String, nullable=False)
    path = Column(String, default="/")
    file_type = Column(String, default="markdown")
    status = Column(String, default="ready")
    owner_id = Column(String, default="default")
    created_at = Column(String, default=lambda: datetime.now().isoformat())
    updated_at = Column(String, default=lambda: datetime.now().isoformat())


class ProjectFileVersion(Base):
    __tablename__ = "project_file_versions"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    file_id = Column(String, ForeignKey("project_files.id", ondelete="CASCADE"), nullable=False)
    version = Column(String, default="1")
    content = Column(Text, nullable=False)
    summary = Column(Text)
    created_by = Column(String, default="default")
    created_at = Column(String, default=lambda: datetime.now().isoformat())


class ProjectSessionFileRef(Base):
    __tablename__ = "project_session_file_refs"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = Column(String, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String, nullable=False)
    file_id = Column(String, nullable=False)
    file_kind = Column(String, nullable=False)
    ref_scope = Column(String, default="round")  # round | pinned
    created_at = Column(String, default=lambda: datetime.now().isoformat())


class ProjectFileActionLog(Base):
    __tablename__ = "project_file_action_logs"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    project_id = Column(String, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    session_id = Column(String)
    message_id = Column(String)
    proposal_id = Column(String, nullable=False)
    action_type = Column(String, nullable=False)
    target_file_id = Column(String)
    result_file_id = Column(String)
    payload_json = Column(Text)
    created_by = Column(String, default="default")
    created_at = Column(String, default=lambda: datetime.now().isoformat())
