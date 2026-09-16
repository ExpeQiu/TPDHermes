"""
知识库 ingestion 合同常量（与 guide/知识库改造.md 三层知识源冻结一致）。
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
        "brand_map",
        "methodology",
    }
)

GEELYWIKI_PAGES_COLLECTION = "internal.geelywiki.pages"
PUBLIC_INTEL_STRATEGY_COLLECTION = "public.public_intel.auto_company_strategy"
PUBLIC_INTEL_VEHICLE_COLLECTION = "public.public_intel.vehicle_model_library"
PUBLIC_INTEL_TECH_COLLECTION = "public.structured_tech.geely_tech"

# TPD 经验库 collection 命名（第五层知识）
TPD_EXPERIENCE_COLLECTION = "public.internal_methodology.tpd_experience"

# 真源集合（稳定顺序）：内部检索唯一入口为 GeelyWiki LLMwiki 归档
KB_AUTHORITATIVE_ORDER: tuple[str, ...] = (GEELYWIKI_PAGES_COLLECTION,)
KB_AUTHORITATIVE_COLLECTIONS: frozenset[str] = frozenset(KB_AUTHORITATIVE_ORDER)

PUBLIC_INTEL_COLLECTIONS: tuple[str, ...] = (
    PUBLIC_INTEL_STRATEGY_COLLECTION,
    PUBLIC_INTEL_VEHICLE_COLLECTION,
    PUBLIC_INTEL_TECH_COLLECTION,
)

KB_INTERNAL_SECTION_ORDER: tuple[str, ...] = KB_AUTHORITATIVE_ORDER

AUTHORITY_CANONICAL = "canonical"
AUTHORITY_EXPERIENCE = "experience"
AUTHORITY_SUPPLEMENT = "supplement"
AUTHORITY_RANK: dict[str, int] = {
    AUTHORITY_CANONICAL: 3,
    AUTHORITY_EXPERIENCE: 2,
    AUTHORITY_SUPPLEMENT: 1,
}

SOURCE_GEELYWIKI = "geelywiki"
SOURCE_PUBLIC_INTEL = "public_intel"
SOURCE_WEB = "web_retrieval"
SOURCE_EXPERIENCE = "tpd_experience"

KB_COLLECTION_DESCRIPTIONS: dict[str, str] = {
    GEELYWIKI_PAGES_COLLECTION: (
        "GeelyWiki 内部 LLMwiki 归档（全文 + claims），真源信息，冲突时优先遵守和采纳。"
    ),
    PUBLIC_INTEL_TECH_COLLECTION: (
        "来自互联网检索的结构化技术点信息，供参考与补充，冲突时以真源集合为准。"
    ),
    PUBLIC_INTEL_STRATEGY_COLLECTION: (
        "公开情报·车企战略，向量+图谱补充，不得覆盖内部 Wiki 搭载与已批准口径。"
    ),
    PUBLIC_INTEL_VEHICLE_COLLECTION: (
        "公开情报·车型库（竞品/行业），向量+图谱补充，节点 id 与内部 Wiki 车型隔离。"
    ),
    TPD_EXPERIENCE_COLLECTION: (
        "对话与反馈沉淀的经验库，可检索可图谱化，权威低于内部 Wiki。"
    ),
    "internal.structured_tech.tech_points": (
        "历史 myKW 直推技术点（已停用直推；现行真源为 internal.geelywiki.pages）。"
    ),
    "public.release_assets.speeches": (
        "历史发言稿集合（现行发布口径编入 GeelyWiki 后随内部 Wiki 检索）。"
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

OPTIONAL_CHUNK_META_KEYS: tuple[str, ...] = (
    "dedupe_key",
    "conversation_id",
    "confidence",
    "harvested_from_user_confirmed",
    "trace_id",
    "created_by",
    "scenario_id",
    "project_id",
    "source_id",
    "output_status",
    "entrypoint",
    "wiki_slug",
    "wiki_type",
    "wiki_domain",
    "layer",
    "publish_scope",
    "claim_id",
    "usage",
    "evidence_kind",
    "authority",
    "knowledge_status",
    "valid_until",
    "brand",
    "brand_id",
    "vehicle_name",
)


def is_public_intel_collection(name: str) -> bool:
    return str(name or "").strip() in PUBLIC_INTEL_COLLECTIONS


def is_geelywiki_collection(name: str) -> bool:
    return str(name or "").strip() == GEELYWIKI_PAGES_COLLECTION
