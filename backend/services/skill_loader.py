"""
SkillLoader - 动态加载外部 Skill 模块的抽象层

目录结构:
  skills/
    my_skill/
      __init__.py      # 导出 Skill 子类
      skill.json       # Skill 元数据 (可选)
    another_skill/
      __init__.py
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import os
import re
import sys
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Dict, List, Optional


# ─── Skill 基类 ──────────────────────────────────────────────────────────────

class Skill(ABC):
    """所有 Skill 必须继承此类并实现标准接口"""

    # 模板内容（由 SkillLoader 自动注入）
    template_content: str | None = None
    # 技能包目录（由 SkillLoader 自动注入）
    skill_path: Path | None = None

    @property
    @abstractmethod
    def name(self) -> str:
        """Skill 唯一标识名"""
        raise NotImplementedError

    @abstractmethod
    def generate(self, context: Dict[str, Any]) -> Dict[str, Any]:
        """
        根据 context 生成内容
        Args:
            context: 包含任务上下文信息的字典
        Returns:
            {"success": bool, "content": str|dict, "error": str|None}
        """
        raise NotImplementedError

    def validate_input(self, input_data: Any) -> bool:
        """
        验证输入是否符合 Skill 预期格式
        默认实现：非空即通过
        子类可override
        """
        return input_data is not None

    def get_template(self) -> str | None:
        """返回关联的模板内容（来自 skill.json template_file）"""
        return self.template_content


# ─── SkillLoader ──────────────────────────────────────────────────────────────

class SkillLoader:
    """从 skills/ 目录动态发现并加载 Skill 子类"""

    def __init__(self, skills_root: Optional[str] = None):
        """
        Args:
            skills_root: skills 目录路径，默认使用项目根目录下的 skills/
        """
        if skills_root is None:
            # 项目根目录
            self.skills_root = Path(__file__).parent.parent.parent / "skills"
        else:
            self.skills_root = Path(skills_root)

        self._cache: Dict[str, Skill] = {}

    # ── 公开 API ──────────────────────────────────────────────────────────────

    def discover(self) -> List[str]:
        """返回所有发现的 Skill 名称列表"""
        names: list[str] = []
        if not self.skills_root.is_dir():
            return names
        for entry in os.listdir(self.skills_root):
            skill_path = self.skills_root / entry
            if skill_path.is_dir() and (skill_path / "__init__.py").exists():
                names.append(entry)
        return names

    def _extract_template_tags_sections(self, skill_path: Path, template_rel: str) -> dict[str, list[str]]:
        """从模版 Markdown 解析 frontmatter tags 与 ## 章节标题。"""
        tpl_path = Path(template_rel)
        if not tpl_path.is_absolute():
            tpl_path = skill_path / tpl_path
        if not tpl_path.is_file():
            return {"tags": [], "sections": []}
        try:
            raw = tpl_path.read_text(encoding="utf-8")
        except Exception:
            return {"tags": [], "sections": []}

        tags: list[str] = []
        sections: list[str] = []
        fm_match = re.match(r"^---\n([\s\S]*?)\n---", raw)
        if fm_match:
            fm = fm_match.group(1)
            tags_match = re.search(r"^tags:\s*\[(.*?)\]\s*$", fm, re.MULTILINE)
            if tags_match:
                tags = [
                    t.strip().strip("\"'")
                    for t in tags_match.group(1).split(",")
                    if t.strip()
                ]
        for line in raw.splitlines():
            m = re.match(r"^##\s+(.+?)\s*$", line)
            if m:
                title = m.group(1).strip()
                if title and title not in sections:
                    sections.append(title)
        return {"tags": tags, "sections": sections}

    def read_skill_json(self, name: str) -> dict[str, Any]:
        """读取 skill.json（不加载 Python 模块），供编排页展示模板选项。"""
        skill_path = self.skills_root / name
        meta_path = skill_path / "skill.json"
        if not meta_path.is_file():
            return {}
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                raw = json.load(f)
            return raw if isinstance(raw, dict) else {}
        except Exception:
            return {}

    def _template_meta_entry(
        self,
        skill_path: Path,
        *,
        tpl_id: str,
        label: str,
        path: str,
    ) -> dict[str, Any]:
        parsed = self._extract_template_tags_sections(skill_path, path)
        return {
            "id": tpl_id,
            "label": label,
            "path": path,
            "tags": parsed["tags"],
            "sections": parsed["sections"],
        }

    def list_skill_metadata(self) -> list[dict[str, Any]]:
        """发现技能及其输出模版选项（来自 skill.json）。"""
        items: list[dict[str, Any]] = []
        for name in self.discover():
            skill_path = self.skills_root / name
            meta = self.read_skill_json(name)
            templates: list[dict[str, Any]] = []
            extra = meta.get("templates")
            if isinstance(extra, list):
                for t in extra:
                    if isinstance(t, dict) and t.get("id"):
                        path = str(t.get("path") or t["id"])
                        templates.append(
                            self._template_meta_entry(
                                skill_path,
                                tpl_id=str(t["id"]),
                                label=str(t.get("label") or t["id"]),
                                path=path,
                            )
                        )
            tpl_path = meta.get("template")
            if isinstance(tpl_path, str) and tpl_path.strip():
                path = tpl_path.strip()
                label = Path(path).name
                display = str(meta.get("name") or name)
                if not any(x["id"] == path for x in templates):
                    templates.append(
                        self._template_meta_entry(
                            skill_path,
                            tpl_id=path,
                            label=f"{display} · {label}",
                            path=path,
                        )
                    )
            items.append(
                {
                    "name": name,
                    "display_name": str(meta.get("name") or name),
                    "description": str(meta.get("description") or ""),
                    "templates": templates,
                }
            )
        return items

    def load(self, name: str) -> Skill:
        """
        加载指定名称的 Skill（带缓存）
        Args:
            name: Skill 目录名
        Returns:
            Skill 实例
        Raises:
            SkillNotFoundError / SkillLoadError
        """
        if name in self._cache:
            return self._cache[name]

        skill_path = self.skills_root / name
        if not skill_path.is_dir():
            raise SkillNotFoundError(f"Skill '{name}' not found at {skill_path}")

        init_file = skill_path / "__init__.py"
        if not init_file.exists():
            raise SkillNotFoundError(f"Skill '{name}' has no __init__.py")

        # 动态导入
        module_name = f"skills.{name}"
        try:
            spec = importlib.util.spec_from_file_location(
                f"{module_name}.__init__", init_file
            )
            if spec is None or spec.loader is None:
                raise SkillLoadError(f"Cannot load spec for '{name}'")
            module = importlib.util.module_from_spec(spec)
            sys.modules[module_name] = module
            spec.loader.exec_module(module)
        except Exception as e:
            raise SkillLoadError(f"Failed to import skill '{name}': {e}") from e

        # 从模块中提取 Skill 子类
        skill_cls = self._find_skill_class(module, name)
        instance = skill_cls()
        instance.skill_path = skill_path

        # 自动加载 skill.json 并注入模板内容
        meta_path = skill_path / "skill.json"
        if meta_path.exists():
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    meta = json.load(f)
                # 注入模板文件路径，供 Skill.generate() 自行加载
                instance.template_file = meta.get("template")
                instance.template_content = self._load_template_content(
                    meta.get("template"), skill_path=skill_path
                )
                instance.skill_meta = meta
            except Exception:
                pass

        self._cache[name] = instance
        return instance

    def _load_template_content(
        self, template_file: str | None, *, skill_path: Path | None = None
    ) -> str | None:
        """根据 skill.json 中的 template 路径加载模板内容。

        相对路径相对于 skill 目录（如 skills/a4_skill/template.md）。
        """
        if not template_file:
            return None
        tpl_path = Path(template_file)
        if not tpl_path.is_absolute() and skill_path:
            # skill 目录下的相对路径
            tpl_path = skill_path / tpl_path
        if tpl_path.exists():
            try:
                raw = tpl_path.read_text(encoding="utf-8")
                # 去掉 YAML frontmatter（---...--- 块）
                import re as _re
                return _re.sub(r'^---\n[\s\S]+?\n---\n', '', raw).lstrip('\n')
            except Exception:
                pass
        return None

    def load_from_package_root(
        self,
        package_root: Path,
        *,
        logical_name: str,
        module_unique_suffix: str,
    ) -> Skill:
        """
        从「已是技能包根目录」的路径加载（如版本快照 skills/.versions/<name>/<ver>/，
        该目录下直接包含 __init__.py），不假设 package_root 下还有 logical_name 子目录。
        """
        package_root = Path(package_root)
        init_file = package_root / "__init__.py"
        if not init_file.is_file():
            raise SkillNotFoundError(
                f"Skill package root has no __init__.py: {package_root}"
            )

        safe = re.sub(r"[^0-9A-Za-z_]", "_", module_unique_suffix)
        cache_key = f"{logical_name}@@{safe}"
        if cache_key in self._cache:
            return self._cache[cache_key]

        module_name = f"tpdx_hermes_skillpkg_{logical_name}_{safe}"
        if module_name in sys.modules:
            del sys.modules[module_name]

        try:
            spec = importlib.util.spec_from_file_location(
                f"{module_name}.__init__", init_file
            )
            if spec is None or spec.loader is None:
                raise SkillLoadError(f"Cannot load spec for versioned '{logical_name}'")
            module = importlib.util.module_from_spec(spec)
            sys.modules[module_name] = module
            spec.loader.exec_module(module)
        except Exception as e:
            raise SkillLoadError(
                f"Failed to import versioned skill '{logical_name}': {e}"
            ) from e

        skill_cls = self._find_skill_class(module, logical_name)
        instance = skill_cls()
        self._cache[cache_key] = instance
        return instance

    def load_all(self) -> Dict[str, Skill]:
        """加载所有发现的 Skill"""
        return {name: self.load(name) for name in self.discover()}

    def call(self, name: str, context: Dict[str, Any]) -> Dict[str, Any]:
        """加载并调用 Skill.generate()，包含输入校验"""
        skill = self.load(name)
        if not skill.validate_input(context):
            return {
                "success": False,
                "content": None,
                "error": f"Invalid input for skill '{name}'"
            }
        try:
            return {"success": True, "content": skill.generate(context), "error": None}
        except Exception as e:
            return {"success": False, "content": None, "error": str(e)}

    # ── 内部 ─────────────────────────────────────────────────────────────────

    def _find_skill_class(self, module: Any, name: str) -> type:
        """从模块中找出 Skill 子类"""
        for attr_name in dir(module):
            attr = getattr(module, attr_name)
            if isinstance(attr, type) and issubclass(attr, Skill) and attr is not Skill:
                return attr
        raise SkillLoadError(
            f"Skill '{name}' module has no Skill subclass. "
            "Make sure your __init__.py exports a class that inherits from Skill."
        )


# ─── 异常 ─────────────────────────────────────────────────────────────────────

class SkillError(Exception):
    """Skill 相关异常基类"""
    pass

class SkillNotFoundError(SkillError):
    pass

class SkillLoadError(SkillError):
    pass


# ─── 全局单例（便捷） ─────────────────────────────────────────────────────────

_default_loader: Optional[SkillLoader] = None

def get_loader() -> SkillLoader:
    global _default_loader
    if _default_loader is None:
        _default_loader = SkillLoader()
    return _default_loader
