"""
技能包目录浏览与文本文件读写（标准 Cursor Skill 布局 + TPD Python 技能包）。

标准布局::
  skill-name/
  ├── SKILL.md        # 必需（Agent 规则）
  ├── scripts/        # 可选
  ├── references/     # 可选
  └── assets/         # 可选
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger("tpdx.hermes.skill_package")

SKIP_DIR_NAMES = frozenset({
    "__pycache__",
    ".git",
    ".versions",
    ".hub",
    "node_modules",
})
SKIP_FILE_NAMES = frozenset({".DS_Store", "Thumbs.db"})

TEXT_EXTENSIONS = frozenset({
    ".md", ".markdown", ".txt", ".json", ".py", ".sh", ".bash", ".js", ".ts",
    ".tsx", ".jsx", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".env",
    ".html", ".css", ".xml", ".csv", ".sql",
})

MAX_READ_BYTES = 512 * 1024
MAX_WRITE_BYTES = 512 * 1024

STANDARD_SKILL_MD_TEMPLATE = """---
name: {name}
description: {description}
---

# {title}

## 使用说明

（在此编写 Agent 使用该技能的规则与流程）

## 触发场景

- 

## 输出要求

- 
"""

STANDARD_SKILL_JSON_TEMPLATE = """{{
  "name": "{display_name}",
  "description": "{description}",
  "version": "1.0.0",
  "author": "TPD Team",
  "template": "template.md"
}}
"""

STANDARD_INIT_PY_TEMPLATE = '''"""
{skill_name} - TPD Python Skill 包
"""

from backend.services.skill_loader import Skill


class {class_name}(Skill):
    @property
    def name(self) -> str:
        return "{skill_name}"

    def generate(self, context):
        return {{"skill": self.name, "context": context}}

    def validate_input(self, input_data):
        return isinstance(input_data, dict)
'''

DIR_README_TEMPLATE = """# {dirname}

（在此目录放置{hint}）
"""

LAYOUT_ITEM_KEYS = frozenset({
    "SKILL.md",
    "scripts",
    "references",
    "assets",
    "__init__.py",
    "skill.json",
})


class SkillPackageError(ValueError):
    pass


def _is_hidden_name(name: str) -> bool:
    return name.startswith(".") and name not in (".env", ".env.example")


def assert_safe_relative_path(rel: str) -> str:
    """校验相对路径，拒绝穿越与绝对路径。"""
    raw = (rel or "").strip().replace("\\", "/")
    if not raw:
        raise SkillPackageError("路径不能为空")
    if raw.startswith("/") or re.match(r"^[A-Za-z]:", raw):
        raise SkillPackageError("非法路径")
    parts = Path(raw).parts
    if ".." in parts:
        raise SkillPackageError("路径不能包含 ..")
    if any(_is_hidden_name(p) for p in parts):
        raise SkillPackageError("不能访问隐藏路径")
    return "/".join(parts)


def resolve_under_root(root: Path, rel: str) -> Path:
    rel_norm = assert_safe_relative_path(rel)
    target = (root / rel_norm).resolve()
    root_res = root.resolve()
    if root_res not in target.parents and target != root_res:
        raise SkillPackageError("路径越界")
    return target


def _guess_text(path: Path) -> bool:
    if path.suffix.lower() in TEXT_EXTENSIONS:
        return True
    if path.name in ("SKILL.md", "skill.json", "Dockerfile", "Makefile"):
        return True
    return False


def _build_tree(root: Path, current: Path) -> List[Dict[str, Any]]:
    nodes: List[Dict[str, Any]] = []
    try:
        entries = sorted(current.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except OSError as e:
        logger.warning("skill_package list failed path=%s err=%s", current, e)
        return nodes

    for entry in entries:
        name = entry.name
        if entry.is_dir():
            if name in SKIP_DIR_NAMES or _is_hidden_name(name):
                continue
            rel = str(entry.relative_to(root)).replace("\\", "/")
            nodes.append({
                "name": name,
                "path": rel,
                "type": "dir",
                "children": _build_tree(root, entry),
            })
        elif entry.is_file():
            if name in SKIP_FILE_NAMES or _is_hidden_name(name):
                continue
            rel = str(entry.relative_to(root)).replace("\\", "/")
            try:
                size = entry.stat().st_size
            except OSError:
                size = 0
            nodes.append({
                "name": name,
                "path": rel,
                "type": "file",
                "size": size,
                "editable": _guess_text(entry),
            })
    return nodes


def standard_layout_status(root: Path) -> Dict[str, bool]:
    return {
        "SKILL.md": (root / "SKILL.md").is_file(),
        "scripts": (root / "scripts").is_dir(),
        "references": (root / "references").is_dir(),
        "assets": (root / "assets").is_dir(),
        "__init__.py": (root / "__init__.py").is_file(),
        "skill.json": (root / "skill.json").is_file(),
    }


def list_package(root: Path, skill_name: str) -> Dict[str, Any]:
    if not root.is_dir():
        raise SkillPackageError(f"技能目录不存在: {skill_name}")
    layout = standard_layout_status(root)
    logger.info(
        "skill_package list name=%s has_skill_md=%s files=%s",
        skill_name,
        layout["SKILL.md"],
        sum(1 for _ in root.rglob("*") if _.is_file()),
    )
    return {
        "name": skill_name,
        "root": str(root),
        "standard_layout": layout,
        "tree": _build_tree(root, root),
    }


def read_package_file(root: Path, rel_path: str) -> Dict[str, Any]:
    target = resolve_under_root(root, rel_path)
    if not target.is_file():
        raise SkillPackageError("文件不存在")
    size = target.stat().st_size
    if size > MAX_READ_BYTES:
        raise SkillPackageError(f"文件过大（>{MAX_READ_BYTES // 1024}KB），请本地编辑")
    editable = _guess_text(target)
    if not editable:
        return {
            "path": rel_path,
            "editable": False,
            "binary": True,
            "size": size,
            "content": None,
            "message": "二进制或非文本文件，仅支持下载到本地查看",
        }
    try:
        content = target.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return {
            "path": rel_path,
            "editable": False,
            "binary": True,
            "size": size,
            "content": None,
            "message": "无法以 UTF-8 解码",
        }
    return {
        "path": rel_path,
        "editable": True,
        "binary": False,
        "size": size,
        "content": content,
    }


def write_package_file(root: Path, rel_path: str, content: str) -> Dict[str, Any]:
    rel_norm = assert_safe_relative_path(rel_path)
    if not _guess_text(Path(rel_norm)):
        raise SkillPackageError("该路径不允许在线编辑")
    encoded = content.encode("utf-8")
    if len(encoded) > MAX_WRITE_BYTES:
        raise SkillPackageError(f"内容过大（>{MAX_WRITE_BYTES // 1024}KB）")
    target = resolve_under_root(root, rel_norm)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    logger.info("skill_package write path=%s bytes=%s", rel_norm, len(encoded))
    return {"path": rel_norm, "size": len(encoded), "saved": True}


def init_skill_md(root: Path, skill_name: str, description: str = "") -> Dict[str, Any]:
    target = root / "SKILL.md"
    if target.is_file():
        raise SkillPackageError("SKILL.md 已存在")
    body = STANDARD_SKILL_MD_TEMPLATE.format(
        name=skill_name,
        description=(description or "待补充").replace("\n", " "),
        title=skill_name.replace("_", " ").title(),
    )
    target.write_text(body, encoding="utf-8")
    logger.info("skill_package init_skill_md name=%s", skill_name)
    return {"path": "SKILL.md", "created": True, "content": body}


def _skill_class_name(skill_name: str) -> str:
    parts = re.split(r"[_\-\s]+", skill_name.strip())
    base = "".join(p[:1].upper() + p[1:] for p in parts if p)
    if not base:
        base = "Custom"
    if not base[0].isalpha():
        base = f"S{base}"
    return f"{base}Skill"


def parse_skill_md_frontmatter(root: Path) -> Dict[str, str]:
    """读取 SKILL.md YAML frontmatter 中的 name / description。"""
    skill_md = root / "SKILL.md"
    if not skill_md.is_file():
        return {}
    try:
        raw = skill_md.read_text(encoding="utf-8")
    except OSError:
        return {}
    match = re.match(r"^---\n([\s\S]*?)\n---", raw)
    if not match:
        return {}
    out: Dict[str, str] = {}
    for line in match.group(1).splitlines():
        m = re.match(r"^(name|description):\s*(.+)\s*$", line.strip())
        if m:
            out[m.group(1)] = m.group(2).strip().strip("\"'")
    return out


def ensure_python_stub(root: Path, skill_name: str) -> bool:
    """
    SKILL.md 包上传时自动生成 __init__.py 桩，便于 SkillLoader 注册。
    已存在 __init__.py 时不覆盖。返回是否新建。
    """
    target = root / "__init__.py"
    if target.is_file():
        return False
    if not (root / "SKILL.md").is_file():
        raise SkillPackageError("技能包缺少 __init__.py 与 SKILL.md")
    class_name = _skill_class_name(skill_name)
    body = STANDARD_INIT_PY_TEMPLATE.format(
        skill_name=skill_name,
        class_name=class_name,
    )
    target.write_text(body, encoding="utf-8")
    logger.info("skill_package ensure_python_stub name=%s", skill_name)
    return True


def _create_standard_dir(root: Path, dirname: str, hint: str) -> Dict[str, Any]:
    dir_path = root / dirname
    if dir_path.is_dir():
        raise SkillPackageError(f"{dirname}/ 已存在")
    dir_path.mkdir(parents=True, exist_ok=True)
    readme = dir_path / "README.md"
    readme.write_text(
        DIR_README_TEMPLATE.format(dirname=dirname, hint=hint),
        encoding="utf-8",
    )
    rel = f"{dirname}/README.md"
    logger.info("skill_package create_dir %s readme=%s", dirname, rel)
    return {
        "item": dirname,
        "created": True,
        "path": rel,
        "type": "dir",
        "open_path": rel,
    }


def create_layout_item(
    root: Path,
    skill_name: str,
    item_key: str,
    description: str = "",
) -> Dict[str, Any]:
    """按标准布局键创建缺失的文件或目录。"""
    key = (item_key or "").strip()
    if key not in LAYOUT_ITEM_KEYS:
        raise SkillPackageError(f"不支持的布局项: {item_key}")

    layout = standard_layout_status(root)
    if layout.get(key):
        raise SkillPackageError(f"{key} 已存在，无需创建")

    desc = (description or "待补充").replace("\n", " ")

    if key == "SKILL.md":
        out = init_skill_md(root, skill_name, desc)
        out["item"] = key
        out["type"] = "file"
        out["open_path"] = "SKILL.md"
        return out

    if key == "scripts":
        return _create_standard_dir(root, "scripts", "可执行脚本（Python / Shell / JS 等）")

    if key == "references":
        return _create_standard_dir(root, "references", "参考文档、API 说明与案例")

    if key == "assets":
        return _create_standard_dir(root, "assets", "模板、图片、字体与配置文件")

    if key == "skill.json":
        target = root / "skill.json"
        body = STANDARD_SKILL_JSON_TEMPLATE.format(
            display_name=skill_name.replace("_", " "),
            description=desc,
        )
        target.write_text(body, encoding="utf-8")
        logger.info("skill_package create skill.json name=%s", skill_name)
        return {
            "item": key,
            "created": True,
            "path": "skill.json",
            "type": "file",
            "open_path": "skill.json",
            "content": body,
        }

    if key == "__init__.py":
        target = root / "__init__.py"
        class_name = _skill_class_name(skill_name)
        body = STANDARD_INIT_PY_TEMPLATE.format(
            skill_name=skill_name,
            class_name=class_name,
        )
        target.write_text(body, encoding="utf-8")
        logger.info("skill_package create __init__.py name=%s", skill_name)
        return {
            "item": key,
            "created": True,
            "path": "__init__.py",
            "type": "file",
            "open_path": "__init__.py",
            "content": body,
        }

    raise SkillPackageError(f"无法创建: {item_key}")
