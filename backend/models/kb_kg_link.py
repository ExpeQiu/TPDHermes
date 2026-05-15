"""KB 缓存条目与知识图谱节点的关联（Hermes 侧权威存储）。"""

from sqlalchemy import Column, String, UniqueConstraint

from backend.db import Base


class KbKgLink(Base):
    __tablename__ = "kb_kg_link"
    __table_args__ = (
        UniqueConstraint(
            "kb_entry_id",
            "kb_project_id",
            "kg_kind",
            "kg_node_id",
            name="uq_kb_kg_link",
        ),
    )

    id = Column(String, primary_key=True)
    kb_entry_id = Column(String, nullable=False, index=True)
    kb_project_id = Column(String, nullable=False, index=True)
    kg_kind = Column(String, nullable=False, index=True)
    kg_node_id = Column(String, nullable=False, index=True)
    created_at = Column(String)
