"""Chroma 查询响应解析与结果构造（kb_proxy 复用）。"""

from __future__ import annotations

from typing import Any


def parse_chroma_query_response(
    data: dict[str, Any],
    *,
    collection_name: str,
) -> list[dict[str, Any]]:
    docs_outer = data.get("documents", [])
    metas_outer = data.get("metadatas", [])
    dists_outer = data.get("distances", [])

    if isinstance(docs_outer, list) and docs_outer and isinstance(docs_outer[0], list):
        docs = docs_outer[0]
    else:
        docs = docs_outer if isinstance(docs_outer, list) else []

    if isinstance(metas_outer, list) and metas_outer and isinstance(metas_outer[0], list):
        metas = metas_outer[0]
    else:
        metas = metas_outer if isinstance(metas_outer, list) else []

    if isinstance(dists_outer, list) and dists_outer and isinstance(dists_outer[0], list):
        dists = dists_outer[0]
    else:
        dists = dists_outer if isinstance(dists_outer, list) else []

    results: list[dict[str, Any]] = []
    for doc, meta, dist in zip(docs, metas, dists):
        m = dict(meta or {})
        if "collection" not in m:
            m["collection"] = collection_name
        results.append(
            {
                "content": doc,
                "metadata": m,
                "distance": dist,
            }
        )
    return results


def build_query_result(
    results: list[dict[str, Any]],
    *,
    source: str = "chroma",
    warning: str | None = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "results": results,
        "source": source,
        "count": len(results),
    }
    if warning:
        out["warning"] = warning
    return out
