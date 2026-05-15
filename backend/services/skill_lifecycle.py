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
import logging
import re
import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from datetime import datetime
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.skill import Skill
from backend.services.skill_loader import SkillLoader, SkillNotFoundError, SkillLoadError
from backend.services.skill_version import SkillVersionService, bump_version

logger = logging.getLogger("tpdx.hermes.skills")


def assert_valid_skill_directory_name(name: str) -> None:
    if not re.match(r"^[a-zA-Z][a-zA-Z0-9_]*$", name):
        raise ValueError("技能目录名须以字母开头，且仅含字母、数字、下划线")


def _iter_extract_root_children(extract_root: Path) -> List[Path]:
    return [p for p in extract_root.iterdir() if p.name != "__MACOSX"]


def resolve_zip_package_root(extract_root: Path) -> Tuple[Path, Optional[str]]:
    """
    解析解压目录中的技能包根目录。
    返回 (含 __init__.py 的目录, 推断的技能名)；若根目录即包且需调用方指定名称则第二项为 None。
    """
    children = _iter_extract_root_children(extract_root)
    if len(children) == 1 and children[0].is_dir():
        pack = children[0]
        if (pack / "__init__.py").is_file():
            return pack, pack.name
    if (extract_root / "__init__.py").is_file():
        return extract_root, None
    raise ValueError(
        "ZIP 须为：单一顶层文件夹且内含 __init__.py；或在 ZIP 根目录直接放置 __init__.py（此时请在表单中填写技能目录名）"
    )


def safe_extract_zip(zf: zipfile.ZipFile, dest: Path) -> None:
    """解压 ZIP，拒绝路径穿越。"""
    base = dest.resolve()
    base.mkdir(parents=True, exist_ok=True)
    for name in zf.namelist():
        if name.startswith("/") or name.startswith("\\"):
            raise ValueError("压缩包包含非法路径")
        parts = Path(name).parts
        if ".." in parts:
            raise ValueError("压缩包包含非法路径")
        target = (base / name).resolve()
        if base not in target.parents and target != base:
            raise ValueError(f"压缩包路径越界: {name}")
    zf.extractall(base)


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

    async def install_from_uploaded_package(
        self,
        package_root: Path,
        skill_name: str,
        description: str = "",
        config: Optional[Dict[str, Any]] = None,
        source: str = "upload",
    ) -> Dict[str, Any]:
        """
        将已校验的目录复制到 skills/<skill_name>/ 并执行 install（失败时回滚磁盘目录）。
        """
        package_root = package_root.resolve()
        if not (package_root / "__init__.py").is_file():
            raise ValueError("技能包缺少 __init__.py")
        assert_valid_skill_directory_name(skill_name)

        existing = await self.get_skill(skill_name)
        if existing:
            raise ValueError(f"Skill '{skill_name}' is already installed")

        dest = self.loader.skills_root / skill_name
        if dest.exists():
            raise ValueError(f"技能目录已存在，无法覆盖：{skill_name}")

        logger.info("skill_upload copy start name=%s from=%s", skill_name, package_root)
        try:
            shutil.copytree(package_root, dest)
        except Exception as e:
            logger.warning("skill_upload copy failed name=%s err=%s", skill_name, e)
            raise ValueError(f"复制技能包失败：{e}") from e

        try:
            out = await self.install(
                name=skill_name,
                description=description,
                config=config,
                source=source,
            )
            logger.info("skill_upload installed name=%s", skill_name)
            return out
        except Exception:
            logger.warning("skill_upload install rollback name=%s", skill_name)
            if dest.exists():
                shutil.rmtree(dest, ignore_errors=True)
            if skill_name in self.loader._cache:
                del self.loader._cache[skill_name]
            raise

    async def install_from_zip_bytes(
        self,
        data: bytes,
        name_override: Optional[str] = None,
        description: str = "",
        config: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """解压 ZIP 并安装到 skills/（结构规则见 resolve_zip_package_root）。"""
        trimmed = name_override.strip() if name_override else ""
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            zip_path = td_path / "upload.zip"
            zip_path.write_bytes(data)
            extract_root = td_path / "out"
            extract_root.mkdir()
            with zipfile.ZipFile(zip_path) as zf:
                safe_extract_zip(zf, extract_root)
            pack_root, inferred = resolve_zip_package_root(extract_root)
            if inferred:
                if trimmed and trimmed != inferred:
                    raise ValueError(
                        f"ZIP 内顶层文件夹须为技能目录名「{inferred}」，请勿在表单中填写其他名称"
                    )
                skill_name = inferred
            else:
                if not trimmed:
                    raise ValueError("ZIP 根目录为技能包时，请在表单中填写技能目录名（name）")
                assert_valid_skill_directory_name(trimmed)
                skill_name = trimmed
            return await self.install_from_uploaded_package(
                pack_root,
                skill_name,
                description=description,
                config=config,
                source="upload",
            )

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
        if not skill_dir.is_dir() or not (skill_dir / "__init__.py").is_file():
            raise ValueError(
                f"技能包目录不存在或缺少 __init__.py：{skill_dir}。"
                "请仅安装仓库 skills/ 下已存在的技能目录名。"
            )
        try:
            self.loader.load(name)
        except SkillLoadError as e:
            raise ValueError(f"技能 '{name}' 无法被加载：{e}") from e

        version = "1.0.0"

        # 目录已校验存在，创建初始快照
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

        skill_dir = self.loader.skills_root / name
        if not skill_dir.is_dir() or not (skill_dir / "__init__.py").is_file():
            raise SkillNotFoundError(
                f"技能目录缺失，无法打版本快照：{skill_dir}"
            )

        # 创建新版本快照（目录必须存在）
        self.version_service.snapshot(name, version, changelog)
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

        src = (skill.source or "local").strip().lower()
        scope = "personal" if src in ("upload", "user") else "public"

        return {
            "id": skill.id,
            "name": skill.name,
            "description": skill.description or "",
            "config": config,
            "version": skill.version,
            "enabled": bool(skill.enabled),
            "source": skill.source,
            "scope": scope,
            "version_history": version_history,
            "installed_at": skill.installed_at,
            "updated_at": skill.updated_at,
        }

    def _parse_version_history(self, raw: str) -> List[Dict[str, Any]]:
        try:
            return json.loads(raw or "[]")
        except json.JSONDecodeError:
            return []
