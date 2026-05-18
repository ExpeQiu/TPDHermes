"""
Workshop / Skill Tools for TPDHermes MCP Server.

Provides:
- Skill discovery
- Skill execution
- KB -> context -> Skill orchestration
"""

import json
import re
from typing import Any

from backend.services.skill_loader import get_loader, SkillNotFoundError, SkillLoadError
from backend.tools.kb_tools import kb_query


def workshop_list_skills() -> dict:
    """
    List all available Skills installed in the workshop.

    Returns:
        {"skills": [str, ...], "count": int}
    """
    loader = get_loader()
    skills = loader.discover()
    return {"skills": sorted(skills), "count": len(skills)}


def workshop_get_skill_info(skill_name: str) -> dict:
    """
    Get detailed information about a specific Skill.

    Args:
        skill_name: Name of the Skill (directory name under skills/)

    Returns:
        {
            "name": str,
            "exists": bool,
            "description": Optional[str],
            "path": str
        }
    """
    loader = get_loader()
    skill_path = loader.skills_root / skill_name

    info = {
        "name": skill_name,
        "exists": skill_path.is_dir(),
        "path": str(skill_path),
        "description": None,
    }

    if not info["exists"]:
        return info

    # Try to load the skill to get class-level info
    try:
        skill = loader.load(skill_name)
        info["description"] = getattr(skill, "__doc__", None)
        # Check for skill.json metadata
        meta_path = skill_path / "skill.json"
        if meta_path.exists():
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
                info["description"] = meta.get("description", info["description"])
                info["version"] = meta.get("version")
                info["author"] = meta.get("author")
    except (SkillNotFoundError, SkillLoadError) as e:
        info["load_error"] = str(e)

    return info


def _truncate(text: str, limit: int = 220) -> str:
    text = " ".join((text or "").split())
    return text[:limit]


def _pick_title(result: dict, fallback: str) -> str:
    metadata = result.get("metadata") or {}
    title = metadata.get("title") or metadata.get("doc_id") or metadata.get("source")
    if title:
        return str(title)
    content = str(result.get("content") or "").strip()
    if content.startswith("#"):
        first_line = content.splitlines()[0].lstrip("#").strip()
        if first_line:
            return first_line
    return fallback


def _build_highlights(results: list[dict], *, prefix: str) -> list[dict[str, str]]:
    highlights: list[dict[str, str]] = []
    for idx, item in enumerate(results[:3], start=1):
        title = _pick_title(item, f"{prefix}{idx}")
        content = _truncate(str(item.get("content") or ""), 120)
        highlights.append({"name": title, "scene_data": content})
    return highlights


def _build_a4_highlights(results: list[dict]) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    for idx, item in enumerate(results[:3], start=1):
        title = _pick_title(item, f"知识亮点{idx}")
        metadata = item.get("metadata") or {}
        source = metadata.get("source") or metadata.get("collection") or "知识库"
        items.append(
            {
                "highlight": title,
                "params": source,
                "user_benefit": _truncate(str(item.get("content") or ""), 80),
            }
        )
    return items


def _build_scene_benefits(results: list[dict]) -> list[dict[str, str]]:
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


def _build_context_from_kb(
    *,
    skill_name: str,
    query: str,
    collection_name: str,
    kb_result: dict,
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

    auto_context: dict[str, Any] = {}

    if skill_name == "speech_skill":
        auto_context = {
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
    elif skill_name == "a4_skill":
        auto_context = {
            "tech_name": top_title or query or "知识增强主题",
            "slogan": f"{top_title}一页式知识提炼",
            "scene_benefits": _build_scene_benefits(results),
            "tech_highlights": _build_a4_highlights(results),
            "test_data": [
                {
                    "data": _extract_metric(str(item.get("content") or "")),
                    "source": str((item.get("metadata") or {}).get("source") or collection_name),
                }
                for item in results[:2]
            ],
            "vehicle_models": [],
        }
    elif skill_name == "video_skill":
        auto_context = {
            "theme": top_title or query or "知识增强主题",
            "hook": _truncate(top_content, 36) or "先看这个真实场景",
            "tech_display": _truncate(top_content, 90) or "基于知识库提炼技术亮点",
            "scene_demo": collection_name,
            "evidence": _extract_metric(top_content),
            "cta": "关注更多真实案例与知识沉淀",
        }
    else:
        auto_context = {
            "tech_name": top_title or query or "知识增强主题",
            "summary": _truncate(top_content, 120),
        }

    final_context = {}
    final_context.update(generic)
    final_context.update(auto_context)
    final_context.update(base_context)
    return final_context


async def workshop_generate(skill_name: str, context: dict) -> dict:
    """
    Execute a Skill's generate() method with the given context.

    Args:
        skill_name: Name of the Skill to execute
        context: Dict passed to Skill.generate(context)

    Returns:
        {
            "success": bool,
            "content": Any,
            "error": Optional[str],
            "skill": str
        }
    """
    loader = get_loader()

    try:
        skill = loader.load(skill_name)
    except SkillNotFoundError:
        return {
            "success": False,
            "content": None,
            "error": f"Skill '{skill_name}' not found",
            "skill": skill_name,
        }
    except SkillLoadError as e:
        return {
            "success": False,
            "content": None,
            "error": f"Failed to load skill '{skill_name}': {e}",
            "skill": skill_name,
        }

    try:
        result = skill.generate(context)
        return {
            "success": True,
            "content": result,
            "error": None,
            "skill": skill_name,
        }
    except Exception as e:
        return {
            "success": False,
            "content": None,
            "error": f"Generation failed: {e}",
            "skill": skill_name,
        }


async def workshop_generate_from_kb(
    skill_name: str,
    query: str,
    collection_name: str,
    limit: int = 3,
    project_id: str | None = None,
    context: dict[str, Any] | None = None,
) -> dict:
    """
    Query the KB, map the results into Skill context, then execute the Skill.

    User-provided context overrides auto-mapped fields.
    """
    kb_result = await kb_query(query, collection_name, limit, project_id)
    built_context = _build_context_from_kb(
        skill_name=skill_name,
        query=query,
        collection_name=collection_name,
        kb_result=kb_result,
        context=context,
    )
    generation = await workshop_generate(skill_name, built_context)
    return {
        "success": generation.get("success", False),
        "skill": skill_name,
        "query": query,
        "collection_name": collection_name,
        "kb": kb_result,
        "context": built_context,
        "generation": generation,
        "error": generation.get("error"),
    }
