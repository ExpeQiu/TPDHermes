"""
SkillVersionService - Skill 版本管理服务

功能：
- 存储每个 Skill 的版本历史
- 加载指定版本的 Skill
- 版本号语义化（semver: major.minor.patch）
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional
from datetime import datetime

from backend.services.skill_loader import SkillLoader, Skill, SkillNotFoundError


# ─── 版本号工具 ───────────────────────────────────────────────────────────────

def parse_version(v: str) -> tuple:
    """解析语义化版本号，返回 (major, minor, patch)"""
    parts = v.lstrip("v").split(".")
    return (
        int(parts[0]) if len(parts) > 0 else 0,
        int(parts[1]) if len(parts) > 1 else 0,
        int(parts[2]) if len(parts) > 2 else 0,
    )


def compare_versions(a: str, b: str) -> int:
    """比较两个版本号: -1=a<b, 0=a==b, 1=a>b"""
    va = parse_version(a)
    vb = parse_version(b)
    if va < vb:
        return -1
    elif va > vb:
        return 1
    return 0


def bump_version(version: str, level: str = "patch") -> str:
    """递增版本号"""
    major, minor, patch = parse_version(version)
    if level == "major":
        return f"{major + 1}.0.0"
    elif level == "minor":
        return f"{major}.{minor + 1}.0"
    else:
        return f"{major}.{minor}.{patch + 1}"


# ─── 版本历史记录 ─────────────────────────────────────────────────────────────

class VersionRecord:
    """单条版本记录"""

    def __init__(self, version: str, changelog: str = "", installed_at: Optional[str] = None):
        self.version = version
        self.changelog = changelog
        self.installed_at = installed_at or datetime.now().isoformat()

    def to_dict(self) -> Dict[str, Any]:
        return {
            "version": self.version,
            "changelog": self.changelog,
            "installed_at": self.installed_at,
        }

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "VersionRecord":
        return cls(
            version=d.get("version", "1.0.0"),
            changelog=d.get("changelog", ""),
            installed_at=d.get("installed_at"),
        )


# ─── SkillVersionService ───────────────────────────────────────────────────────

class SkillVersionService:
    """
    管理 Skill 的版本历史，支持：
    - 记录安装/更新版本
    - 查询版本历史
    - 加载指定版本（通过 SkillLoader + 版本化目录）
    """

    # 版本快照存储目录（skills/.versions/<skill_name>/<version>/）
    VERSION_ROOT = Path(__file__).parent.parent.parent / "skills" / ".versions"

    def __init__(self, loader: Optional[SkillLoader] = None):
        self.loader = loader or SkillLoader()

    # ── 快照管理 ────────────────────────────────────────────────────────────

    def _version_dir(self, skill_name: str, version: str) -> Path:
        return self.VERSION_ROOT / skill_name / version

    def snapshot(self, skill_name: str, version: str, changelog: str = "") -> Path:
        """
        为指定版本的 Skill 创建快照副本
        Returns: 快照目录路径
        """
        source = self.loader.skills_root / skill_name
        if not source.exists():
            raise SkillNotFoundError(f"Skill '{skill_name}' not found at {source}")

        dest = self._version_dir(skill_name, version)
        dest.parent.mkdir(parents=True, exist_ok=True)

        # 增量同步（避免重复拷贝）
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(source, dest)

        # 写入版本元数据
        meta = dest / ".version_meta.json"
        meta.write_text(json.dumps({
            "skill_name": skill_name,
            "version": version,
            "changelog": changelog,
            "snapshotted_at": datetime.now().isoformat(),
        }, ensure_ascii=False, indent=2))

        return dest

    def get_versions(self, skill_name: str) -> List[Dict[str, Any]]:
        """
        返回指定 Skill 的所有快照版本列表
        """
        version_root = self.VERSION_ROOT / skill_name
        if not version_root.exists():
            return []

        versions = []
        for vdir in version_root.iterdir():
            if vdir.is_dir():
                meta_file = vdir / ".version_meta.json"
                if meta_file.exists():
                    meta = json.loads(meta_file.read_text())
                    versions.append(meta)
                else:
                    versions.append({"version": vdir.name, "changelog": "", "snapshotted_at": ""})
        # 按版本号降序排列
        versions.sort(key=lambda x: parse_version(x["version"]), reverse=True)
        return versions

    def load_version(self, skill_name: str, version: str) -> Skill:
        """
        加载指定版本的 Skill（从快照目录加载）
        """
        vdir = self._version_dir(skill_name, version)
        if not vdir.exists():
            raise SkillNotFoundError(
                f"Version '{version}' of skill '{skill_name}' not found. "
                f"Snapshot at {vdir} does not exist."
            )

        # 临时切换 skills_root 来加载指定版本
        original_root = self.loader.skills_root
        try:
            self.loader.skills_root = vdir
            self.loader._cache.clear()
            skill = self.loader.load(skill_name)
            return skill
        finally:
            self.loader.skills_root = original_root
            self.loader._cache.clear()

    def delete_version(self, skill_name: str, version: str) -> None:
        """删除指定版本的快照"""
        vdir = self._version_dir(skill_name, version)
        if vdir.exists():
            shutil.rmtree(vdir)

    # ── 版本元数据持久化 ────────────────────────────────────────────────────

    @staticmethod
    def encode_version_history(records: List[VersionRecord]) -> str:
        return json.dumps([r.to_dict() for r in records], ensure_ascii=False)

    @staticmethod
    def decode_version_history(raw: str) -> List[VersionRecord]:
        if not raw:
            return []
        try:
            data = json.loads(raw)
            return [VersionRecord.from_dict(d) for d in data]
        except json.JSONDecodeError:
            return []
