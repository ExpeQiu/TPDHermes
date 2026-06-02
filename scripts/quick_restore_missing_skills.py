#!/usr/bin/env python3
"""快速恢复缺失技能目录为临时可运行兜底实现。"""

import argparse
import re
import sqlite3
from typing import List
from pathlib import Path


def _class_name(skill_name: str) -> str:
    parts = re.split(r"[^a-zA-Z0-9]+", skill_name)
    name = "".join(p[:1].upper() + p[1:] for p in parts if p)
    if not name:
        name = "SkillStub"
    if name[0].isdigit():
        name = f"Skill{name}"
    return f"{name}Skill"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True, help="SQLite db path")
    parser.add_argument("--skills-root", required=True, help="skills root path")
    args = parser.parse_args()

    db_path = Path(args.db)
    skills_root = Path(args.skills_root)
    skills_root.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(db_path))
    cur = conn.cursor()
    rows = cur.execute(
        "SELECT name, IFNULL(description, '') FROM skills WHERE enabled=1 ORDER BY updated_at DESC"
    ).fetchall()

    created = []  # type: List[str]
    skipped = []  # type: List[str]

    for skill_name, _desc in rows:
        skill_dir = skills_root / skill_name
        init_py = skill_dir / "__init__.py"
        if init_py.exists():
            skipped.append(skill_name)
            continue

        skill_dir.mkdir(parents=True, exist_ok=True)
        cls = _class_name(skill_name)
        code = f'''"""
{skill_name} - temporary fallback skill
"""

from backend.services.skill_loader import Skill


class {cls}(Skill):
    @property
    def name(self) -> str:
        return "{skill_name}"

    def generate(self, context):
        return {{
            "skill": self.name,
            "mode": "temporary_fallback",
            "message": "该技能源码已缺失，当前为临时可用兜底实现，请尽快重新上传正式技能包。",
            "context": context,
        }}

    def validate_input(self, input_data):
        return isinstance(input_data, dict)
'''
        init_py.write_text(code, encoding="utf-8")
        (skill_dir / "SKILL.md").write_text(
            f"# {skill_name}\n\n临时兜底技能（自动恢复）。\n",
            encoding="utf-8",
        )
        created.append(skill_name)

    print(f"created={len(created)}")
    for name in created:
        print(f"+ {name}")
    print(f"skipped_existing={len(skipped)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
