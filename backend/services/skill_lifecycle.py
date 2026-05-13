"""
SkillLifecycleService - Skill 生命周期管理

功能：
- 安装 Skill（从市场/本地）
- 更新 Skill 到新版本
- 启用/禁用 Skill
- 删除 Skill
"""

from __future__ import annotations

import json
import shutil
import zipfile
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional
from datetime import datetime
import uuid

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.skill import Skill
from backend.services.skill_loader import SkillLoader, SkillNotFoundError
from backend.services.skill_version import SkillVersionService, bump_version


class SkillLifecycleService:
    """管理 Skill 的完整生命周期"""

    def __init__(self, db: AsyncSession, loader: Optional[SkillLoader] = None):
        self.db = db
        self.loader = loader or SkillLoader()
        self.version_service = SkillVersionService(self.loader)

    # ── 基础 CRUD ────────────────────────────────────────────────────────────

    async def list_skills(self, enabled_only: bool = False) -> List[Dict[str, Any]]:
        """列出所有已安装的 Skill"""
        query = select(Skill)
        if enabled_only:
            query = query.where(Skill.enabled == 1)
        result = await self.db.execute(query)
        skills = result.scalars().all()
        return [self._skill_to_dict(s) for s in skills]

    async def get_skill(self, name: str) -> Optional[Dict[str, Any]]:
        """获取单个 Skill 信息"""
        result = await self.db.execute(select(Skill).where(Skill.name == name))
        skill = result.scalar_one_or_none()
        if not skill:
            return None
        return self._skill_to_dict(skill)

    async def install(
        self,
        name: str,
        description: str = "",
        config: Optional[Dict[str, Any]] = None,
        source: str = "local",
    ) -> Dict[str, Any]:
        """
        安装一个新 Skill
        - 写入数据库记录
        - 创建初始版本快照
        """
        # 检查是否已存在
        existing = await self.get_skill(name)
        if existing:
            raise ValueError(f"Skill '{name}' is already installed")

        skill_dir = self.loader.skills_root / name
        version = "1.0.0"

        # 如果目录存在，创建初始快照
        if skill_dir.exists():
            self.version_service.snapshot(name, version, "Initial install")

        skill = Skill(
            id=str(uuid.uuid4()),
            name=name,
            description=description,
            config=json.dumps(config or {}, ensure_ascii=False),
            version=version,
            enabled=1,
            source=source,
            version_history=json.dumps([{
                "version": version,
                "changelog": "Initial install",
                "installed_at": datetime.now().isoformat(),
            }], ensure_ascii=False),
        )
        self.db.add(skill)
        await self.db.commit()
        await self.db.refresh(skill)
        return self._skill_to_dict(skill)

    async def update_skill(
        self,
        name: str,
        changelog: str = "",
        new_version: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        更新 Skill 到新版本
        - 递增版本号（默认 patch）
        - 快照新版本
        - 更新数据库记录
        """
        skill = await self._get_db_skill(name)
        if not skill:
            raise SkillNotFoundError(f"Skill '{name}' not found")

        old_version = skill.version
        if new_version:
            version = new_version
        else:
            version = bump_version(old_version)

        # 创建新版本快照
        try:
            self.version_service.snapshot(name, version, changelog)
        except SkillNotFoundError:
            # 目录不存在则跳过快照
            pass

        # 更新版本历史
        history = json.loads(skill.version_history or "[]")
        history.append({
            "version": version,
            "changelog": changelog or f"Updated from {old_version}",
            "installed_at": datetime.now().isoformat(),
        })

        skill.version = version
        skill.version_history = json.dumps(history, ensure_ascii=False)
        skill.updated_at = datetime.now().isoformat()
        await self.db.commit()
        await self.db.refresh(skill)
        return self._skill_to_dict(skill)

    async def set_enabled(self, name: str, enabled: bool) -> Dict[str, Any]:
        """启用/禁用 Skill"""
        skill = await self._get_db_skill(name)
        if not skill:
            raise SkillNotFoundError(f"Skill '{name}' not found")
        skill.enabled = 1 if enabled else 0
        skill.updated_at = datetime.now().isoformat()
        await self.db.commit()
        await self.db.refresh(skill)
        return self._skill_to_dict(skill)

    async def update_config(self, name: str, config: Dict[str, Any]) -> Dict[str, Any]:
        """更新 Skill 配置"""
        skill = await self._get_db_skill(name)
        if not skill:
            raise SkillNotFoundError(f"Skill '{name}' not found")
        skill.config = json.dumps(config, ensure_ascii=False)
        skill.updated_at = datetime.now().isoformat()
        await self.db.commit()
        await self.db.refresh(skill)
        return self._skill_to_dict(skill)

    async def uninstall(self, name: str, keep_versions: bool = True) -> None:
        """
        卸载（删除）Skill
        - 删除数据库记录
        - 删除版本快照（可选）
        - 不删除 skills/ 源目录（保留源代码）
        """
        skill = await self._get_db_skill(name)
        if not skill:
            raise SkillNotFoundError(f"Skill '{name}' not found")

        await self.db.delete(skill)
        await self.db.commit()

        # 删除版本快照
        if not keep_versions:
            vroot = self.version_service.VERSION_ROOT / name
            if vroot.exists():
                shutil.rmtree(vroot)

        # 清除加载器缓存
        if name in self.loader._cache:
            del self.loader._cache[name]

    # ── 辅助 ─────────────────────────────────────────────────────────────────

    async def _get_db_skill(self, name: str) -> Optional[Skill]:
        result = await self.db.execute(select(Skill).where(Skill.name == name))
        return result.scalar_one_or_none()

    def _skill_to_dict(self, skill: Skill) -> Dict[str, Any]:
        config = {}
        try:
            config = json.loads(skill.config or "{}")
        except json.JSONDecodeError:
            pass

        version_history = []
        try:
            version_history = json.loads(skill.version_history or "[]")
        except json.JSONDecodeError:
            pass

        return {
            "id": skill.id,
            "name": skill.name,
            "description": skill.description or "",
            "config": config,
            "version": skill.version,
            "enabled": bool(skill.enabled),
            "source": skill.source,
            "version_history": version_history,
            "installed_at": skill.installed_at,
            "updated_at": skill.updated_at,
        }

    def _parse_version_history(self, raw: str) -> List[Dict[str, Any]]:
        try:
            return json.loads(raw or "[]")
        except json.JSONDecodeError:
            return []
