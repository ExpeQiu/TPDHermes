"""从 skills/<name>/scripts/generate_*.py 渲染 Markdown 内容。"""

from __future__ import annotations

import importlib.util
import logging
import re
from pathlib import Path
from typing import Any

logger = logging.getLogger("tpdx.hermes.skill_script_runner")


def find_generate_script(skill_dir: Path) -> Path | None:
    scripts_dir = skill_dir / "scripts"
    if not scripts_dir.is_dir():
        return None
    matches = sorted(scripts_dir.glob("generate_*.py"))
    return matches[0] if matches else None


def _load_script_module(script_path: Path):
    safe = re.sub(r"[^0-9A-Za-z_]", "_", str(script_path))
    module_name = f"tpdx_skill_script_{safe}"
    spec = importlib.util.spec_from_file_location(module_name, script_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"无法加载脚本: {script_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def resolve_template_path(skill_dir: Path, script_module: Any) -> Path:
    default = getattr(script_module, "DEFAULT_TEMPLATE", None)
    if default:
        path = Path(default)
        if path.is_file():
            return path
    templates_dir = skill_dir / "templates"
    if templates_dir.is_dir():
        md_files = sorted(templates_dir.glob("*.md"))
        if md_files:
            return md_files[0]
    raise FileNotFoundError(f"技能包缺少模板: {skill_dir}")


def generate_content_from_scripts(skill_dir: Path, context: dict[str, Any]) -> str:
    """调用 scripts/generate_*.py 的 normalize + render 生成 Markdown。"""
    skill_dir = skill_dir.resolve()
    script_path = find_generate_script(skill_dir)
    if not script_path:
        raise FileNotFoundError(f"技能包缺少 scripts/generate_*.py: {skill_dir}")

    module = _load_script_module(script_path)
    normalize = getattr(module, "normalize", None)
    render = getattr(module, "render", None)
    if not callable(normalize) or not callable(render):
        raise AttributeError(f"脚本缺少 normalize/render: {script_path}")

    data = context if isinstance(context, dict) else {}
    template_path = resolve_template_path(skill_dir, module)
    normalized = normalize(data)
    if not isinstance(normalized, dict):
        raise TypeError(f"normalize 须返回 dict: {script_path}")

    content = render(template_path.read_text(encoding="utf-8"), normalized)
    logger.info(
        "skill_script_runner rendered skill=%s script=%s template=%s chars=%s",
        skill_dir.name,
        script_path.name,
        template_path.name,
        len(content),
    )
    return content
