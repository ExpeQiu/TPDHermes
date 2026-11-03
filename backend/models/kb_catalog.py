from datetime import datetime

from sqlalchemy import Column, String

from backend.db import Base


class KbCatalogItem(Base):
    """知识库分类目录：自定义业务域、目录路径，以及内置业务域的显示名覆盖。"""

    __tablename__ = "kb_catalog_items"

    id = Column(String, primary_key=True)
    kind = Column(String, nullable=False, index=True)
    item_key = Column(String, nullable=False)
    label = Column(String, nullable=False)
    parent_key = Column(String)
    scope = Column(String)
    builtin = Column(String, nullable=False, default="0")
    created_at = Column(String, default=lambda: datetime.now().isoformat())
    updated_at = Column(String, default=lambda: datetime.now().isoformat())
