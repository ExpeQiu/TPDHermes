"""知识库 collection 业务目录常量。"""

from backend.services.kb_contract import (
    KB_AUTHORITATIVE_COLLECTIONS,
    KB_COLLECTION_DESCRIPTIONS,
)

# 前端 catalog 与后端真源集合应对齐（通过字符串常量校验，避免重复维护漂移）
FRONTEND_INTERNAL_SECTION_ORDER = [
    "internal.structured_tech.tech_points",
    "public.release_assets.speeches",
]
FRONTEND_HIDDEN = {
    "internal.structured_tech.smoke",
    "public.structured_tech.remote_debug",
}


def test_authoritative_collections_include_internal_and_speeches():
    assert "internal.structured_tech.tech_points" in KB_AUTHORITATIVE_COLLECTIONS
    assert "public.release_assets.speeches" in KB_AUTHORITATIVE_COLLECTIONS
    assert "public.structured_tech.geely_tech" not in KB_AUTHORITATIVE_COLLECTIONS


def test_collection_descriptions_cover_renamed_pools():
    assert "互联网检索" in KB_COLLECTION_DESCRIPTIONS["public.structured_tech.geely_tech"]
    assert "JLGF" in KB_COLLECTION_DESCRIPTIONS["internal.structured_tech.tech_points"]
    assert "真源" in KB_COLLECTION_DESCRIPTIONS["public.release_assets.speeches"]


def test_internal_section_order_matches_authoritative():
    assert FRONTEND_INTERNAL_SECTION_ORDER == list(KB_AUTHORITATIVE_COLLECTIONS)


def test_hidden_collections_exclude_smoke_and_remote_debug():
    assert "internal.structured_tech.smoke" in FRONTEND_HIDDEN
    assert "public.structured_tech.remote_debug" in FRONTEND_HIDDEN
