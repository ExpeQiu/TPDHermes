"""知识库 collection 业务目录常量。"""

from backend.services.kb_contract import (
    GEELYWIKI_PAGES_COLLECTION,
    KB_AUTHORITATIVE_COLLECTIONS,
    KB_AUTHORITATIVE_ORDER,
    KB_COLLECTION_DESCRIPTIONS,
    KB_INTERNAL_SECTION_ORDER,
    PUBLIC_INTEL_COLLECTIONS,
    TPD_EXPERIENCE_COLLECTION,
)

FRONTEND_INTERNAL_SECTION_ORDER = [
    "internal.geelywiki.pages",
]
FRONTEND_HIDDEN = {
    "internal.structured_tech.smoke",
    "public.structured_tech.remote_debug",
}


def test_authoritative_collections_are_geelywiki_only():
    assert GEELYWIKI_PAGES_COLLECTION in KB_AUTHORITATIVE_COLLECTIONS
    assert KB_AUTHORITATIVE_ORDER == (GEELYWIKI_PAGES_COLLECTION,)
    assert "internal.structured_tech.tech_points" not in KB_AUTHORITATIVE_COLLECTIONS
    assert "public.release_assets.speeches" not in KB_AUTHORITATIVE_COLLECTIONS
    assert "public.structured_tech.geely_tech" not in KB_AUTHORITATIVE_COLLECTIONS


def test_collection_descriptions_cover_three_layers():
    assert "LLMwiki" in KB_COLLECTION_DESCRIPTIONS[GEELYWIKI_PAGES_COLLECTION]
    assert "补充" in KB_COLLECTION_DESCRIPTIONS["public.structured_tech.geely_tech"]
    assert "经验库" in KB_COLLECTION_DESCRIPTIONS[TPD_EXPERIENCE_COLLECTION]


def test_internal_section_order_matches_authoritative():
    assert list(KB_INTERNAL_SECTION_ORDER) == FRONTEND_INTERNAL_SECTION_ORDER
    assert FRONTEND_INTERNAL_SECTION_ORDER == list(KB_AUTHORITATIVE_ORDER)


def test_public_intel_collections_are_three():
    assert len(PUBLIC_INTEL_COLLECTIONS) == 3


def test_hidden_collections_exclude_smoke_and_remote_debug():
    assert "internal.structured_tech.smoke" in FRONTEND_HIDDEN
    assert "public.structured_tech.remote_debug" in FRONTEND_HIDDEN
