"""
知识库 ingestion 合同常量（与 guide/知识库改造.md v1 冻结一致）。
"""

from __future__ import annotations

# metadata.domain 建议枚举（文档「Domain 规范」）
KB_DOMAIN_ENUM: frozenset[str] = frozenset(
    {
        "public_intel",
        "structured_tech",
        "release_assets",
        "market_research",
        "policy_regulation",
        "internal_methodology",
    }
)

# 文档级 chunk metadata 必填（写入 Chroma 前校验）
KB_REQUIRED_METADATA_KEYS: tuple[str, ...] = (
    "id",
    "title",
    "domain",
    "folder_path",
    "source",
    "published",
    "doc_id",
    "chunk_index",
    "chunk_count",
)
