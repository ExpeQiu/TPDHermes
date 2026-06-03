#!/usr/bin/env python3
"""将仅透传 context 的桩 __init__.py 替换为脚本渲染实现。"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.services.skill_package import STANDARD_INIT_PY_TEMPLATE, _skill_class_name

logger = logging.getLogger("patch_script_stub_skills")

STUB_SKILLS = [
    "ip_pack_skill",
    "ip_shelf_skill",
    "display_concept_skill",
    "display_project_skill",
    "display_guide_skill",
    "brand_name_skill",
    "brand_research_plan",
    "brand_research_report",
    "ip_cert_plan",
]

STUB_MARKER = 'return {"skill": self.name, "context": context}'


def is_context_stub(init_path: Path) -> bool:
    if not init_path.is_file():
        return False
    return STUB_MARKER in init_path.read_text(encoding="utf-8")


def patch_skill(skills_root: Path, skill_name: str, force: bool = False) -> bool:
    skill_dir = skills_root / skill_name
    init_py = skill_dir / "__init__.py"
    scripts = list((skill_dir / "scripts").glob("generate_*.py"))
    if not scripts:
        logger.warning("skip %s: no generate_*.py", skill_name)
        return False
    if init_py.is_file() and not force and not is_context_stub(init_py):
        logger.info("skip %s: not a context stub", skill_name)
        return False

    class_name = _skill_class_name(skill_name)
    body = STANDARD_INIT_PY_TEMPLATE.format(
        skill_name=skill_name,
        class_name=class_name,
    )
    init_py.write_text(body, encoding="utf-8")
    logger.info("patched %s class=%s", skill_name, class_name)
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skills-root", default=str(ROOT / "skills"))
    parser.add_argument("--force", action="store_true", help="覆盖非桩 __init__.py")
    parser.add_argument("names", nargs="*", help="指定技能名，默认 9 个桩技能")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    skills_root = Path(args.skills_root)
    names = args.names or STUB_SKILLS
    patched = sum(1 for n in names if patch_skill(skills_root, n, force=args.force))
    logger.info("patched %s/%s skills", patched, len(names))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
