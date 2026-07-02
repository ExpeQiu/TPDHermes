"""项目 KB 为空时 /chat 公共知识库回退。"""

from backend.services.project_kb import (
    CHAT_KB_FALLBACK_COLLECTIONS,
    merge_chat_kb_fallback_collections,
    merge_co_create_ask_kb_collections,
    project_kb_collection,
)


def test_merge_chat_kb_fallback_collections_unions_public():
    pid = "p-empty-001"
    project_col = project_kb_collection(pid)
    merged = merge_chat_kb_fallback_collections([project_col])
    assert merged[0] == project_col
    for col in CHAT_KB_FALLBACK_COLLECTIONS:
        assert col in merged


def test_merge_co_create_ask_kb_collections_unions_public_even_when_project_has_cols():
    pid = "p-ask-001"
    project_col = project_kb_collection(pid)
    merged = merge_co_create_ask_kb_collections(["tpd_docs"], pid)
    assert merged[0] == project_col
    assert "tpd_docs" in merged
    for col in CHAT_KB_FALLBACK_COLLECTIONS:
        assert col in merged


def test_merge_chat_kb_fallback_collections_dedupes():
    pid = "p-empty-002"
    project_col = project_kb_collection(pid)
    first = merge_chat_kb_fallback_collections([project_col])
    second = merge_chat_kb_fallback_collections(first)
    assert first == second
