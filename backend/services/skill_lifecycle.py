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

from sqlalchemy import select, or_
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.skill import Skill
from backend.services.skill_loader import SkillLoader, SkillNotFoundError, SkillLoadError
from backend.services.skill_package import ensure_python_stub, parse_skill_md_frontmatter
from backend.services.skill_version import SkillVersionService, bump_version
from backend.services.user_identity import is_global_admin_user
from backend.services.resource_visibility import skill_dict_visibility_fields

logger = logging.getLogger("tpdx.hermes.skills")


def assert_valid_skill_directory_name(name: str) -> None:
    if not re.match(r"^[a-zA-Z][a-zA-Z0-9_]*$", name):
        raise ValueError("技能目录名须以字母开头，且仅含字母、数字、下划线")


def upload_replace_allowed(existing: Optional[Dict[str, Any]], owner_id: str) -> bool:
    """上传 ZIP 是否允许覆盖已有技能（公共/市场技能不可覆盖）。"""
    if existing is None:
        return True
    src = (existing.get("source") or "").strip()
    oid = (existing.get("owner_id") or "").strip()
    uid = (owner_id or "").strip()
    if src == "upload":
        return True
    if oid and uid and oid == uid:
        return True
    return False


def _iter_extract_root_children(extract_root: Path) -> List[Path]:
    return [p for p in extract_root.iterdir() if p.name != "__MACOSX"]


def resolve_zip_package_root(extract_root: Path) -> Tuple[Path, Optional[str]]:
    """
    解析解压目录中的技能包根目录。
    返回 (技能包根目录, 推断的技能名)；若根目录即包且需调用方指定名称则第二项为 None。
    支持 Python 包（__init__.py）或标准 SKILL.md 布局。
    """
    children = _iter_extract_root_children(extract_root)
    if len(children) == 1 and children[0].is_dir():
        pack = children[0]
        if (pack / "__init__.py").is_file() or (pack / "SKILL.md").is_file():
            return pack, pack.name
    if (extract_root / "__init__.py").is_file() or (extract_root / "SKILL.md").is_file():
        return extract_root, None
    raise ValueError(
        "ZIP 须为：单一顶层文件夹且内含 __init__.py 或 SKILL.md；"
        "或在 ZIP 根目录直接放置 __init__.py / SKILL.md（此时请在表单中填写技能目录名）"
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

    async def list_skills(self, enabled_only: bool = False, viewer_user_id: str | None = None) -> List[Dict[str, Any]]:
        """列出已安装的 Skill；viewer_user_id 非空时按 owner 过滤。"""
        query = select(Skill)
        if enabled_only:
            query = query.where(Skill.enabled == 1)
        if viewer_user_id is not None and not is_global_admin_user(viewer_user_id):
            vu = viewer_user_id.strip()
            query = query.where(
                or_(
                    Skill.owner_id == "",
                    Skill.owner_id == vu,
                )
            )
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
        owner_id: str = "",
    ) -> Dict[str, Any]:
        """
        将已校验的目录复制到 skills/<skill_name>/ 并执行 install（失败时回滚磁盘目录）。
        """
        package_root = package_root.resolve()
        if not (package_root / "__init__.py").is_file():
            if (package_root / "SKILL.md").is_file():
                ensure_python_stub(package_root, skill_name)
                logger.info("skill_upload stub __init__.py name=%s", skill_name)
            else:
                raise ValueError("技能包缺少 __init__.py 或 SKILL.md")
        assert_valid_skill_directory_name(skill_name)

        existing = await self.get_skill(skill_name)
        dest = self.loader.skills_root / skill_name
        replacing = existing is not None or dest.exists()
        if replacing:
            if existing and not upload_replace_allowed(existing, owner_id):
                raise ValueError(
                    f"技能「{skill_name}」已存在（公共/市场技能），无法通过 ZIP 覆盖，请先卸载或使用其他目录名"
                )
            return await self._replace_uploaded_package(
                package_root,
                skill_name,
                description=description,
                config=config,
                source=source,
                owner_id=owner_id,
                existing=existing,
            )

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
                owner_id=owner_id,
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

    async def _replace_uploaded_package(
        self,
        package_root: Path,
        skill_name: str,
        description: str = "",
        config: Optional[Dict[str, Any]] = None,
        source: str = "upload",
        owner_id: str = "",
        existing: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """覆盖已有上传技能或仅磁盘残留目录，并归属当前用户。"""
        dest = self.loader.skills_root / skill_name
        backup: Optional[Path] = None
        logger.info(
            "skill_upload replace start name=%s owner=%s had_db=%s",
            skill_name,
            (owner_id or "")[:24],
            existing is not None,
        )
        try:
            if dest.exists():
                backup = dest.with_name(f".{skill_name}.upload_bak")
                if backup.exists():
                    shutil.rmtree(backup, ignore_errors=True)
                dest.rename(backup)
            shutil.copytree(package_root, dest)
            if skill_name in self.loader._cache:
                del self.loader._cache[skill_name]
            try:
                self.loader.load(skill_name)
            except SkillLoadError as e:
                raise ValueError(f"技能 '{skill_name}' 无法被加载：{e}") from e

            db_skill = await self._get_db_skill(skill_name)
            if db_skill:
                version = bump_version(db_skill.version)
                self.version_service.snapshot(skill_name, version, "Re-upload from ZIP")
                history = json.loads(db_skill.version_history or "[]")
                history.append({
                    "version": version,
                    "changelog": "Re-upload from ZIP",
                    "installed_at": datetime.now().isoformat(),
                })
                if description.strip():
                    db_skill.description = description
                if config is not None:
                    db_skill.config = json.dumps(config, ensure_ascii=False)
                db_skill.version = version
                db_skill.source = source
                db_skill.owner_id = (owner_id or "").strip()
                db_skill.enabled = 1
                db_skill.version_history = json.dumps(history, ensure_ascii=False)
                db_skill.updated_at = datetime.now().isoformat()
                await self.db.commit()
                await self.db.refresh(db_skill)
                if backup and backup.exists():
                    shutil.rmtree(backup, ignore_errors=True)
                logger.info("skill_upload replaced name=%s version=%s", skill_name, version)
                return self._skill_to_dict(db_skill)

            out = await self.install(
                name=skill_name,
                description=description,
                config=config,
                source=source,
                owner_id=owner_id,
            )
            if backup and backup.exists():
                shutil.rmtree(backup, ignore_errors=True)
            logger.info("skill_upload replaced name=%s (new db record)", skill_name)
            return out
        except Exception:
            logger.warning("skill_upload replace rollback name=%s", skill_name)
            if dest.exists():
                shutil.rmtree(dest, ignore_errors=True)
            if backup and backup.exists():
                backup.rename(dest)
            if skill_name in self.loader._cache:
                del self.loader._cache[skill_name]
            raise

    async def install_from_zip_bytes(
        self,
        data: bytes,
        name_override: Optional[str] = None,
        description: str = "",
        config: Optional[Dict[str, Any]] = None,
        owner_id: str = "",
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
            frontmatter = parse_skill_md_frontmatter(pack_root)
            if inferred:
                if trimmed and trimmed != inferred:
                    raise ValueError(
                        f"ZIP 内顶层文件夹须为技能目录名「{inferred}」，请勿在表单中填写其他名称"
                    )
                skill_name = inferred
            else:
                if not trimmed:
                    fm_name = (frontmatter.get("name") or "").strip()
                    if fm_name:
                        assert_valid_skill_directory_name(fm_name)
                        skill_name = fm_name
                    else:
                        raise ValueError("ZIP 根目录为技能包时，请在表单中填写技能目录名（name）")
                else:
                    assert_valid_skill_directory_name(trimmed)
                    skill_name = trimmed
            fm_name = (frontmatter.get("name") or "").strip()
            if fm_name and fm_name != skill_name:
                raise ValueError(
                    f"SKILL.md frontmatter 中 name 为「{fm_name}」，与技能目录名「{skill_name}」不一致"
                )
            desc = description
            if not desc.strip():
                desc = (frontmatter.get("description") or "").strip()
            return await self.install_from_uploaded_package(
                pack_root,
                skill_name,
                description=desc,
                config=config,
                source="upload",
                owner_id=owner_id,
            )

    async def install(
        self,
        name: str,
        description: str = "",
        config: Optional[Dict[str, Any]] = None,
        source: str = "local",
        owner_id: str = "",
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
            owner_id=(owner_id or "").strip(),
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
        own = getattr(skill, "owner_id", None) or ""

        base = {
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
        base.update(skill_dict_visibility_fields(str(own)))
        return base

    def _parse_version_history(self, raw: str) -> List[Dict[str, Any]]:
        try:
            return json.loads(raw or "[]")
        except json.JSONDecodeError:
            return []
