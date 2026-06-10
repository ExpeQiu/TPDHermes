"""KB 来源捕获与引用解析单元测试。"""
from __future__ import annotations

from backend.services.kb_source_capture import (
    _merge_sources,
    annotate_results_with_capture,
    build_sources_payload_from_capture,
    extract_citation_refs_from_text,
    extract_sources_from_kb_query_payload,
)


def test_merge_sources_dedup_and_increment_ref():
    existing = {
        "sources": [
            {
                "ref": 1,
                "chunk_id": "doc_a_chunk_0001",
                "title": "A",
                "collection": "c1",
                "excerpt": "hello",
                "query_order": 1,
            }
        ]
    }
    new_items = [
        {
            "chunk_id": "doc_a_chunk_0001",
            "title": "A",
            "collection": "c1",
            "excerpt": "hello",
            "tool": "kb_query",
        },
        {
            "chunk_id": "doc_b_chunk_0002",
            "title": "B",
            "collection": "c1",
            "excerpt": "world",
            "tool": "kb_query",
        },
    ]
    merged = _merge_sources(existing, new_items)
    sources = merged["sources"]
    assert len(sources) == 2
    assert sources[0]["ref"] == 1
    assert sources[1]["ref"] == 2
    assert sources[1]["chunk_id"] == "doc_b_chunk_0002"


def test_extract_sources_from_kb_query_payload():
    payload = {
        "results": [
            {
                "content": "GEA 架构说明",
                "metadata": {
                    "id": "doc_x_chunk_0003",
                    "doc_id": "doc_x",
                    "title": "技术白皮书",
                    "chunk_index": 3,
                    "chunk_count": 10,
                    "collection": "project.test.kb",
                },
                "distance": 0.15,
            }
        ]
    }
    items = extract_sources_from_kb_query_payload(payload, collection_name="project.test.kb")
    assert len(items) == 1
    assert items[0]["chunk_id"] == "doc_x_chunk_0003"
    assert items[0]["title"] == "技术白皮书"
    assert items[0]["chunk_index"] == 3


def test_build_sources_payload_unresolved_refs():
    capture = {
        "sources": [
            {
                "ref": 1,
                "chunk_id": "c1",
                "title": "T1",
                "collection": "col",
                "excerpt": "ex",
            }
        ]
    }
    text = "基于 GEA[^1] 以及未知[^9] 描述。"
    payload = build_sources_payload_from_capture(capture, text)
    assert payload["citations_count"] == 1
    assert payload["sources"][0]["ref"] == 1
    assert 9 in payload["unresolved_refs"]
    assert 1 not in payload["unresolved_refs"]


def test_extract_citation_refs_from_text():
    refs = extract_citation_refs_from_text("A[^1] B[^2] C[^1]")
    assert refs == [1, 2]


def test_annotate_results_with_capture():
    capture = {
        "sources": [
            {"ref": 2, "chunk_id": "doc_y_chunk_0001"},
        ]
    }
    rows = [{"content": "x", "metadata": {"id": "doc_y_chunk_0001"}}]
    out = annotate_results_with_capture(rows, capture)
    assert out[0]["ref"] == 2
