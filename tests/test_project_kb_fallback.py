"""项目 KB 为空时 /chat 公共知识库回退。"""

from backend.services.project_kb import (
    CHAT_KB_FALLBACK_COLLECTIONS,
    merge_chat_kb_fallback_collections,
    project_kb_collection,
)


def test_merge_chat_kb_fallback_collections_unions_public():
    pid = "p-empty-001"
    project_col = project_kb_collection(pid)
    merged = merge_chat_kb_fallback_collections([project_col])
    assert merged[0] == project_col
    for col in CHAT_KB_FALLBACK_COLLECTIONS:
        assert col in merged


def test_merge_chat_kb_fallback_collections_dedupes():
    pid = "p-empty-002"
    project_col = project_kb_collection(pid)
    first = merge_chat_kb_fallback_collections([project_col])
    second = merge_chat_kb_fallback_collections(first)
    assert first == second
