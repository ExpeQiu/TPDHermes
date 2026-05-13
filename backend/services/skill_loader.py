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
import sys
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Dict, List, Optional


# ─── Skill 基类 ──────────────────────────────────────────────────────────────

class Skill(ABC):
    """所有 Skill 必须继承此类并实现标准接口"""

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
        names = []
        if not self.skills_root.is_dir():
            return names
        for entry in os.listdir(self.skills_root):
            skill_path = self.skills_root / entry
            if skill_path.is_dir() and (skill_path / "__init__.py").exists():
                names.append(entry)
        return names

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
        self._cache[name] = instance
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
