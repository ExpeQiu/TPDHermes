"""
Workshop / Skill Tools for TPDHermes MCP Server

Wraps SkillLoader for MCP access.
"""

import json
from pathlib import Path
from typing import Any

from backend.services.skill_loader import get_loader, SkillNotFoundError, SkillLoadError


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
