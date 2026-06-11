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

# TPD 经验库 collection 命名（第五层知识）
TPD_EXPERIENCE_COLLECTION = "public.internal_methodology.tpd_experience"

# 真源集合：与其它 collection 冲突时 Agent 须优先采纳
KB_AUTHORITATIVE_COLLECTIONS: frozenset[str] = frozenset(
    {
        "internal.structured_tech.tech_points",
        "public.release_assets.speeches",
    }
)

KB_COLLECTION_DESCRIPTIONS: dict[str, str] = {
    "public.structured_tech.geely_tech": (
        "来自互联网检索的结构化技术点信息，供参考与补充，冲突时以真源集合为准。"
    ),
    "internal.structured_tech.tech_points": (
        "内部官方技术点汇编（JLGF），真源信息，优先遵守和采纳。"
    ),
    "public.release_assets.speeches": (
        "发言稿与发布口径，真源信息，优先遵守和采纳。"
    ),
}

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
