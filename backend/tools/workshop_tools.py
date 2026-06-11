"""
Workshop / Skill Tools for TPDHermes MCP Server.

Provides:
- Skill discovery
- Skill execution
- KB -> context -> Skill orchestration
"""

import json
from typing import Any

from backend.db import async_session_maker
from backend.services.workshop_context_adapter import build_workshop_context_from_kb
from backend.services.workshop_guard import WorkshopGuardError, require_tphermes_run_id, require_workshop_invocation
from backend.services.skill_loader import get_loader, SkillNotFoundError, SkillLoadError
from backend.services.workshop_skill_access import (
    visible_workshop_skill_names,
    workshop_skill_accessible,
)
from backend.tools.kb_tools import kb_query


async def workshop_list_skills(user_id: str | None = None) -> dict:
    """
    List all available Skills installed in the workshop.

    Returns:
        {"skills": [str, ...], "count": int}
    """
    uid = (user_id or "").strip()
    loader = get_loader()
    if uid:
        async with async_session_maker() as db:
            visible = await visible_workshop_skill_names(
                db,
                uid,
                enabled_only=True,
                require_loadable=True,
            )
        skills = [name for name in loader.discover() if name in visible]
    else:
        skills = loader.discover()
    return {"skills": sorted(skills), "count": len(skills)}


async def workshop_get_skill_info(skill_name: str, user_id: str | None = None) -> dict:
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
    uid = (user_id or "").strip()
    loader = get_loader()
    skill_path = loader.skills_root / skill_name

    info = {
        "name": skill_name,
        "exists": skill_path.is_dir(),
        "path": str(skill_path),
        "description": None,
    }

    if uid:
        async with async_session_maker() as db:
            if not await workshop_skill_accessible(
                db,
                viewer_user_id=uid,
                skill_name=skill_name,
                enabled_only=True,
            ):
                info["exists"] = False
                info["path"] = ""
                info["error"] = "Skill not visible to current user"
                return info

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
        require_tphermes_run_id((context or {}).get("tphermes_run_id"))
        async with async_session_maker() as db:
            await require_workshop_invocation(
                db,
                tphermes_run_id=str((context or {}).get("tphermes_run_id") or ""),
                skill_name=skill_name,
                project_id=(context or {}).get("project_id"),
            )
    except WorkshopGuardError as exc:
        return {
            "success": False,
            "content": None,
            "error": exc.detail,
            "skill": skill_name,
        }

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
        payload = {
            "success": True,
            "content": result,
            "error": None,
            "skill": skill_name,
        }
        from backend.services.workshop_tool_capture import save_workshop_tool_capture_for_context

        await save_workshop_tool_capture_for_context(
            context,
            "workshop_generate",
            payload,
            skill_name=skill_name,
        )
        return payload
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
    ctx = dict(context or {})
    try:
        async with async_session_maker() as db:
            invocation = await require_workshop_invocation(
                db,
                tphermes_run_id=str(ctx.get("tphermes_run_id") or ""),
                skill_name=skill_name,
                project_id=project_id or ctx.get("project_id"),
                collection_name=collection_name,
            )
    except WorkshopGuardError as exc:
        return {
            "success": False,
            "skill": skill_name,
            "query": query,
            "collection_name": collection_name,
            "kb": {"results": [], "count": 0},
            "context": ctx,
            "generation": None,
            "error": exc.detail,
        }

    run_id = invocation.run_id
    effective_project_id = invocation.project_id
    effective_collection_name = invocation.collection_name or collection_name
    ctx["tphermes_run_id"] = run_id
    if effective_project_id:
        ctx["project_id"] = effective_project_id
    kb_result = await kb_query(
        query,
        effective_collection_name,
        limit,
        effective_project_id,
        tphermes_run_id=run_id,
    )
    built_context = build_workshop_context_from_kb(
        skill_name=skill_name,
        query=query,
        collection_name=effective_collection_name,
        kb_result=kb_result,
        context=ctx,
    )
    generation = await workshop_generate(skill_name, built_context)
    payload = {
        "success": generation.get("success", False),
        "skill": skill_name,
        "query": query,
        "collection_name": effective_collection_name,
        "kb": kb_result,
        "context": built_context,
        "generation": generation,
        "error": generation.get("error"),
    }
    from backend.services.workshop_tool_capture import save_workshop_tool_capture_for_context

    await save_workshop_tool_capture_for_context(
        built_context,
        "workshop_generate_from_kb",
        payload,
        skill_name=skill_name,
    )
    return payload
