"""
Skills Store API - 技能商店

端点：
  GET  /skills              - 列出已安装的 Skills
  GET  /skills/:name        - 获取单个 Skill 详情（含版本历史）
  POST /skills              - 安装 Skill（触发生命周期管理）
  PUT  /skills/:name        - 更新 Skill 版本
  PATCH /skills/:name/enable  - 启用/禁用
  PATCH /skills/:name/config - 更新配置
  DELETE /skills/:name      - 卸载 Skill
  GET  /skills/:name/versions - 获取版本历史
  POST /skills/:name/versions/:version/load - 加载指定版本（预览）
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Depends, Query, File, UploadFile, Form
from pydantic import BaseModel
from typing import Any, Dict, List, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import get_db
from backend.services.skill_lifecycle import SkillLifecycleService
from backend.services.skill_version import SkillVersionService
from backend.services.skill_loader import SkillNotFoundError, get_loader


router = APIRouter(prefix="/skills", tags=["skills"])
logger = logging.getLogger("tpdx.hermes.skills")

SKILL_UPLOAD_MAX_BYTES = 20 * 1024 * 1024


# ─── Pydantic Schemas ─────────────────────────────────────────────────────────

class SkillInstallRequest(BaseModel):
    name: str
    description: str = ""
    config: Optional[Dict[str, Any]] = None
    source: str = "local"


class SkillUpdateRequest(BaseModel):
    changelog: str = ""
    new_version: Optional[str] = None


class SkillConfigRequest(BaseModel):
    config: Dict[str, Any]


class SkillEnableRequest(BaseModel):
    enabled: bool


class SkillResponse(BaseModel):
    id: str
    name: str
    description: str
    config: Dict[str, Any]
    version: str
    enabled: bool
    source: str
    version_history: List[Dict[str, Any]]
    installed_at: str
    updated_at: str


# ─── Marketplace catalog（静态原型数据）────────────────────────────────────────

MARKETPLACE_CATALOG = [
    {
        "name": "hello_skill",
        "display_name": "Hello 示例",
        "description": "最小示例技能，用于联调与验证加载链路",
        "icon": "👋",
        "category": "文档类",
        "latest_version": "1.0.0",
        "author": "TPD Team",
        "tags": ["示例", "联调"],
        "installs": 12,
        "rating": 5.0,
    },
    {
        "name": "speech_skill",
        "display_name": "发言稿",
        "description": "生成领导讲话、产品发布、技术分享等场景的正式发言稿",
        "icon": "🎤",
        "category": "文档类",
        "latest_version": "1.2.0",
        "author": "TPD Team",
        "tags": ["讲话", "演讲", "PPT"],
        "installs": 342,
        "rating": 4.8,
    },
    {
        "name": "video_skill",
        "display_name": "视频脚本",
        "description": "生成短视频/宣传片的分镜脚本，包含旁白和画面描述",
        "icon": "🎬",
        "category": "文档类",
        "latest_version": "1.1.0",
        "author": "TPD Team",
        "tags": ["视频", "脚本", "宣传片"],
        "installs": 218,
        "rating": 4.6,
    },
    {
        "name": "a4_skill",
        "display_name": "A4一页纸",
        "description": "单页精华文档，提炼核心信息，适合快速阅读和传播",
        "icon": "📄",
        "category": "文档类",
        "latest_version": "1.0.0",
        "author": "TPD Team",
        "tags": ["一页纸", "摘要", "精华"],
        "installs": 156,
        "rating": 4.5,
    },
]


# ─── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/", response_model=List[SkillResponse])
async def list_skills(
    enabled_only: bool = Query(False, description="仅返回已启用的 Skill"),
    db: AsyncSession = Depends(get_db),
):
    """列出所有已安装的 Skills"""
    svc = SkillLifecycleService(db, get_loader())
    skills = await svc.list_skills(enabled_only=enabled_only)
    return skills


@router.get("/marketplace", response_model=List[Dict[str, Any]])
async def get_marketplace(
    q: str = Query("", description="搜索关键词"),
    category: str = Query("", description="分类筛选"),
):
    """浏览 Skill 市场目录（支持搜索和分类筛选）"""
    results = MARKETPLACE_CATALOG
    if q:
        q_lower = q.lower()
        results = [
            s for s in results
            if q_lower in s["name"].lower()
            or q_lower in s["display_name"].lower()
            or q_lower in s["description"].lower()
            or any(q_lower in tag.lower() for tag in s.get("tags", []))
        ]
    if category:
        results = [s for s in results if s["category"] == category]
    return results


@router.get("/marketplace/categories", response_model=List[str])
async def get_categories():
    """获取市场分类列表"""
    cats = sorted(set(s["category"] for s in MARKETPLACE_CATALOG))
    return cats


@router.post("/upload", response_model=SkillResponse)
async def upload_skill_package(
    file: UploadFile = File(..., description="ZIP 技能包"),
    name: Optional[str] = Form(None, description="ZIP 根目录为包时必填；单文件夹 ZIP 须留空"),
    description: str = Form(""),
    db: AsyncSession = Depends(get_db),
):
    """
    上传 ZIP 安装技能：须含可加载的 Python 包（__init__.py），结构见 SkillLifecycleService.install_from_zip_bytes。
    """
    if not file.filename or not file.filename.lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="请上传 .zip 文件")
    raw = await file.read()
    if len(raw) > SKILL_UPLOAD_MAX_BYTES:
        raise HTTPException(status_code=400, detail=f"文件过大，上限 {SKILL_UPLOAD_MAX_BYTES // (1024 * 1024)}MB")
    logger.info(
        "skill_upload request filename=%s size=%s name_form=%s",
        file.filename,
        len(raw),
        name,
    )
    svc = SkillLifecycleService(db, get_loader())
    try:
        return await svc.install_from_zip_bytes(
            raw,
            name_override=name,
            description=description or "",
            config=None,
        )
    except ValueError as e:
        logger.warning("skill_upload rejected: %s", e)
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/{name}", response_model=SkillResponse)
async def get_skill(name: str, db: AsyncSession = Depends(get_db)):
    """获取单个 Skill 详情"""
    svc = SkillLifecycleService(db, get_loader())
    skill = await svc.get_skill(name)
    if not skill:
        raise HTTPException(status_code=404, detail=f"Skill '{name}' not found")
    return skill


@router.post("/", response_model=SkillResponse)
async def install_skill(data: SkillInstallRequest, db: AsyncSession = Depends(get_db)):
    """安装一个新 Skill"""
    svc = SkillLifecycleService(db, get_loader())
    try:
        skill = await svc.install(
            name=data.name,
            description=data.description,
            config=data.config,
            source=data.source,
        )
        return skill
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))


@router.put("/{name}", response_model=SkillResponse)
async def update_skill(name: str, data: SkillUpdateRequest, db: AsyncSession = Depends(get_db)):
    """更新 Skill 到新版本"""
    svc = SkillLifecycleService(db, get_loader())
    try:
        skill = await svc.update_skill(name=name, changelog=data.changelog, new_version=data.new_version)
        return skill
    except SkillNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.patch("/{name}/enable", response_model=SkillResponse)
async def toggle_skill(name: str, data: SkillEnableRequest, db: AsyncSession = Depends(get_db)):
    """启用/禁用 Skill"""
    svc = SkillLifecycleService(db, get_loader())
    try:
        skill = await svc.set_enabled(name, data.enabled)
        return skill
    except SkillNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.patch("/{name}/config", response_model=SkillResponse)
async def update_config(name: str, data: SkillConfigRequest, db: AsyncSession = Depends(get_db)):
    """更新 Skill 配置"""
    svc = SkillLifecycleService(db, get_loader())
    try:
        skill = await svc.update_config(name, data.config)
        return skill
    except SkillNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.delete("/{name}")
async def uninstall_skill(name: str, db: AsyncSession = Depends(get_db)):
    """卸载 Skill"""
    svc = SkillLifecycleService(db, get_loader())
    try:
        await svc.uninstall(name)
        return {"message": f"Skill '{name}' uninstalled successfully"}
    except SkillNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/{name}/versions")
async def get_versions(name: str):
    """获取 Skill 版本历史"""
    vs = SkillVersionService(get_loader())
    versions = vs.get_versions(name)
    return {"skill": name, "versions": versions}


@router.post("/{name}/versions/{version}/load")
async def load_version(name: str, version: str):
    """加载指定版本的 Skill（预览，返回 Skill 实例信息）"""
    vs = SkillVersionService(get_loader())
    try:
        skill = vs.load_version(name, version)
        return {
            "name": skill.name,
            "version_loaded": version,
            "message": f"Version {version} of '{name}' loaded successfully",
        }
    except SkillNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
