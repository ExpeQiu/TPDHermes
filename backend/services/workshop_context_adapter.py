"""Workshop KB -> context 适配器。"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any


def _truncate(text: str, limit: int = 220) -> str:
    text = " ".join((text or "").split())
    return text[:limit]


def _pick_title(result: dict[str, Any], fallback: str) -> str:
    metadata = result.get("metadata") if isinstance(result.get("metadata"), dict) else {}
    title = metadata.get("title") or metadata.get("doc_id") or metadata.get("source")
    if title:
        return str(title)
    content = str(result.get("content") or "").strip()
    if content.startswith("#"):
        first_line = content.splitlines()[0].lstrip("#").strip()
        if first_line:
            return first_line
    return fallback


def _build_highlights(results: list[dict[str, Any]], *, prefix: str) -> list[dict[str, str]]:
    highlights: list[dict[str, str]] = []
    for idx, item in enumerate(results[:3], start=1):
        title = _pick_title(item, f"{prefix}{idx}")
        content = _truncate(str(item.get("content") or ""), 120)
        highlights.append({"name": title, "scene_data": content})
    return highlights


def _build_a4_highlights(results: list[dict[str, Any]]) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    for idx, item in enumerate(results[:3], start=1):
        title = _pick_title(item, f"知识亮点{idx}")
        metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
        source = metadata.get("source") or metadata.get("collection") or "知识库"
        items.append(
            {
                "highlight": title,
                "params": str(source),
                "user_benefit": _truncate(str(item.get("content") or ""), 80),
            }
        )
    return items


def _build_scene_benefits(results: list[dict[str, Any]]) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    for idx, item in enumerate(results[:3], start=1):
        title = _pick_title(item, f"场景{idx}")
        items.append(
            {
                "scene": title,
                "benefit": _truncate(str(item.get("content") or ""), 70),
            }
        )
    return items


def _extract_metric(text: str) -> str:
    match = re.search(r"(\d+(?:\.\d+)?(?:km/h|%|ms|秒|分钟|小时))", text)
    if match:
        return match.group(1)
    return "可直接复用知识库中的已验证结论"


def _default_adapter(
    *,
    query: str,
    collection_name: str,
    results: list[dict[str, Any]],
    top_title: str,
    top_content: str,
) -> dict[str, Any]:
    _ = (collection_name, results)
    return {
        "tech_name": top_title or query or "知识增强主题",
        "summary": _truncate(top_content, 120),
    }


def _speech_skill_adapter(
    *,
    query: str,
    collection_name: str,
    results: list[dict[str, Any]],
    top_title: str,
    top_content: str,
) -> dict[str, Any]:
    return {
        "tech_name": top_title or query or "知识增强主题",
        "slogan": f"{top_title}知识增强输出",
        "scene_pain": _truncate(top_content, 60) or "目标场景存在待解决问题",
        "specific_problem": _truncate(top_content, 40) or "需要复用知识库中的经验",
        "tech_solution": _truncate(top_content, 120) or f"基于{collection_name}中的知识给出方案",
        "key_conflict": "效率与准确性的平衡",
        "highlights": _build_highlights(results, prefix="知识亮点"),
        "reproducible_scene": collection_name,
        "quantitative_metric": _extract_metric(top_content),
        "user_value": "减少重复摸索，加快内容输出",
        "cta": "如需深入可继续追问并扩展到更多知识条目",
    }


def _a4_skill_adapter(
    *,
    query: str,
    collection_name: str,
    results: list[dict[str, Any]],
    top_title: str,
    top_content: str,
) -> dict[str, Any]:
    _ = top_content
    return {
        "tech_name": top_title or query or "知识增强主题",
        "slogan": f"{top_title}一页式知识提炼",
        "scene_benefits": _build_scene_benefits(results),
        "tech_highlights": _build_a4_highlights(results),
        "test_data": [
            {
                "data": _extract_metric(str(item.get("content") or "")),
                "source": str(
                    (
                        item.get("metadata")
                        if isinstance(item.get("metadata"), dict)
                        else {}
                    ).get("source")
                    or collection_name
                ),
            }
            for item in results[:2]
        ],
        "vehicle_models": [],
    }


def _video_skill_adapter(
    *,
    query: str,
    collection_name: str,
    results: list[dict[str, Any]],
    top_title: str,
    top_content: str,
) -> dict[str, Any]:
    _ = results
    return {
        "theme": top_title or query or "知识增强主题",
        "hook": _truncate(top_content, 36) or "先看这个真实场景",
        "tech_display": _truncate(top_content, 90) or "基于知识库提炼技术亮点",
        "scene_demo": collection_name,
        "evidence": _extract_metric(top_content),
        "cta": "关注更多真实案例与知识沉淀",
    }


KBContextAdapter = Callable[..., dict[str, Any]]

_KB_CONTEXT_ADAPTERS: dict[str, KBContextAdapter] = {
    "speech_skill": _speech_skill_adapter,
    "a4_skill": _a4_skill_adapter,
    "video_skill": _video_skill_adapter,
}


def build_workshop_context_from_kb(
    *,
    skill_name: str,
    query: str,
    collection_name: str,
    kb_result: dict[str, Any],
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    base_context = dict(context or {})
    results = list(kb_result.get("results") or [])
    top = results[0] if results else {}
    top_content = str(top.get("content") or "")
    top_title = _pick_title(top, query or collection_name)
    source_name = kb_result.get("source") or "kb"

    generic = {
        "knowledge_query": query,
        "knowledge_collection": collection_name,
        "knowledge_source": source_name,
        "knowledge_count": kb_result.get("count", 0),
        "knowledge_results": results,
        "knowledge_excerpt": _truncate(top_content, 300),
    }

    adapter = _KB_CONTEXT_ADAPTERS.get(skill_name, _default_adapter)
    auto_context = adapter(
        query=query,
        collection_name=collection_name,
        results=results,
        top_title=top_title,
        top_content=top_content,
    )

    final_context: dict[str, Any] = {}
    final_context.update(generic)
    final_context.update(auto_context)
    final_context.update(base_context)
    return final_context
