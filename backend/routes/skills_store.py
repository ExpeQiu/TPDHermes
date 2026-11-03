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
  POST /skills/:name/versions/:version/restore - 用快照覆盖工作区并回拨版本指针
"""

from __future__ import annotations

import json
import logging
import shutil
import uuid
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, HTTPException, Depends, Query, File, UploadFile, Form
from pydantic import BaseModel
from typing import Any, Dict, List, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import get_db
from backend.services.run_log_service import create_run, finalize_run
from backend.services.skill_lifecycle import SkillLifecycleService
from backend.services.skill_metrics_service import build_skill_usage_view
from backend.services.workshop_llm_generator import execute_workshop_skill_generate
from backend.services.skill_version import SkillVersionService
from backend.services.skill_loader import SkillNotFoundError, get_loader
from backend.services.skill_package import (
    SkillPackageError,
    create_layout_item,
    init_skill_md,
    list_package,
    read_package_file,
    write_package_file,
)
from backend.services.resource_visibility import skill_installation_visible
from backend.services.user_identity import get_effective_user_id, is_global_admin_user


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


class SkillPublishGlobalRequest(BaseModel):
    publish: bool = True


class SkillTrialRequest(BaseModel):
    fields: Dict[str, Any] = {}
    collection_name: str = ""


class SkillPackageFileWriteRequest(BaseModel):
    path: str
    content: str


class SkillLayoutItemRequest(BaseModel):
    item: str


class MarketplaceInstallRequest(BaseModel):
    name: str
    target_name: str = ""
    description: str = ""


class SkillResponse(BaseModel):
    id: str
    name: str
    description: str
    config: Dict[str, Any]
    version: str
    enabled: bool
    source: str
    # scope：public=工作区/市场安装；personal=本地上传（ZIP）等
    scope: str = "public"
    owner_id: str = ""
    owner_type: str = "platform"
    visibility: str = "global"
    version_history: List[Dict[str, Any]]
    installed_at: str
    updated_at: str
    config_source: Optional[str] = None
    config_keys_count: Optional[int] = None


# ─── Helpers ───────────────────────────────────────────────────────────────────

async def _resolve_skill_package_root(
    name: str,
    db: AsyncSession,
    effective_uid: str,
) -> tuple[dict[str, Any], Path]:
    """返回 (skill dict, 磁盘包根目录)。"""
    svc = SkillLifecycleService(db, get_loader())
    skill = await svc.get_skill(name)
    if not skill:
        raise HTTPException(status_code=404, detail=f"Skill '{name}' not found")
    if not skill_installation_visible(skill.get("owner_id"), effective_uid):
        raise HTTPException(status_code=404, detail=f"Skill '{name}' not found")
    root = get_loader().skills_root / name
    if not root.is_dir():
        raise HTTPException(status_code=404, detail=f"Skill package directory not found: {name}")
    return skill, root


def _safe_owner_alias(owner_id: str) -> str:
    trimmed = (owner_id or "").strip()
    if not trimmed:
        return "TPD Team"
    if len(trimmed) <= 12:
        return trimmed
    return f"{trimmed[:6]}...{trimmed[-4:]}"


def _normalize_market_tags(config: Dict[str, Any]) -> list[str]:
    tags = config.get("market_tags")
    if isinstance(tags, list):
        return [str(x).strip() for x in tags if str(x).strip()][:8]
    return []


def _normalize_market_icon(config: Dict[str, Any]) -> str:
    icon = str(config.get("market_icon") or "").strip()
    return icon or "📦"


def _normalize_market_category(config: Dict[str, Any], source: str) -> str:
    category = str(config.get("market_category") or "").strip()
    if category:
        return category
    if source == "upload":
        return "文档类"
    if source == "user":
        return "知识类"
    return "效率类"


def _date_only(iso_text: str) -> str:
    raw = (iso_text or "").strip()
    if len(raw) >= 10 and raw[4] == "-" and raw[7] == "-":
        return raw[:10]
    return "1970-01-01"


def _skill_to_market_row(skill: Dict[str, Any]) -> Dict[str, Any]:
    config = skill.get("config") if isinstance(skill.get("config"), dict) else {}
    source = str(skill.get("source") or "local").strip().lower()
    owner_id = str(skill.get("owner_id") or "").strip()
    display_name = str(config.get("display_name") or "").strip() or str(skill.get("name") or "")
    return {
        "name": skill.get("name", ""),
        "display_name": display_name,
        "description": skill.get("description", ""),
        "icon": _normalize_market_icon(config),
        "category": _normalize_market_category(config, source),
        "latest_version": skill.get("version", "1.0.0"),
        "author": _safe_owner_alias(owner_id),
        "tags": _normalize_market_tags(config),
        "installs": 0,
        "rating": None,
        "updated_at": _date_only(str(skill.get("updated_at") or "")),
        "publisher_id": owner_id,
        "source": source,
    }


async def _resolve_market_install_name(
    svc: SkillLifecycleService,
    preferred_name: str,
    effective_uid: str,
) -> str:
    base = preferred_name.strip()
    if not base:
        raise HTTPException(status_code=400, detail="技能名不能为空")
    existing = await svc.get_skill(base)
    if not existing:
        return base
    existing_owner = (existing.get("owner_id") or "").strip()
    if existing_owner == (effective_uid or "").strip():
        return base
    uid_part = (effective_uid or "user").replace(":", "_").replace("-", "_")[:12]
    candidate = f"{base}__{uid_part}"
    if not await svc.get_skill(candidate):
        return candidate
    for idx in range(2, 200):
        name = f"{candidate}_{idx}"
        if not await svc.get_skill(name):
            return name
    raise HTTPException(status_code=409, detail="无法为安装副本分配唯一名称")


# ─── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/", response_model=List[SkillResponse])
async def list_skills(
    enabled_only: bool = Query(False, description="仅返回已启用的 Skill"),
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    """列出所有已安装的 Skills"""
    svc = SkillLifecycleService(db, get_loader())
    skills = await svc.list_skills(enabled_only=enabled_only, viewer_user_id=effective_uid)
    return skills


@router.get("/marketplace", response_model=List[Dict[str, Any]])
async def get_marketplace(
    q: str = Query("", description="搜索关键词"),
    category: str = Query("", description="分类筛选"),
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    """浏览 Skill 市场目录（汇总全体用户创建并已安装的技能）。"""
    svc = SkillLifecycleService(db, get_loader())
    all_skills = await svc.list_skills(enabled_only=False, viewer_user_id=None)
    results = [_skill_to_market_row(skill) for skill in all_skills]
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
    logger.info(
        "skills_marketplace list viewer=%s total=%s after_filter=%s q=%s category=%s",
        effective_uid[:24],
        len(all_skills),
        len(results),
        q,
        category,
    )
    return results


@router.get("/marketplace/categories", response_model=List[str])
async def get_categories(db: AsyncSession = Depends(get_db)):
    """获取市场分类列表（动态）。"""
    svc = SkillLifecycleService(db, get_loader())
    all_skills = await svc.list_skills(enabled_only=False, viewer_user_id=None)
    rows = [_skill_to_market_row(skill) for skill in all_skills]
    cats = sorted(set(s["category"] for s in rows))
    return cats


@router.post("/marketplace/install", response_model=SkillResponse)
async def install_skill_from_marketplace(
    data: MarketplaceInstallRequest,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    """从市场安装技能；当同名被他人占用时自动创建个人副本名。"""
    source_name = (data.name or "").strip()
    if not source_name:
        raise HTTPException(status_code=400, detail="name 不能为空")
    svc = SkillLifecycleService(db, get_loader())
    source_skill = await svc.get_skill(source_name)
    if not source_skill:
        raise HTTPException(status_code=404, detail=f"Skill '{source_name}' not found in marketplace")

    requested_name = (data.target_name or "").strip() or source_name
    target_name = await _resolve_market_install_name(svc, requested_name, effective_uid)
    target_skill = await svc.get_skill(target_name)
    if target_skill and (target_skill.get("owner_id") or "").strip() == (effective_uid or "").strip():
        logger.info("skills_marketplace install skip existing user=%s skill=%s", effective_uid[:24], target_name)
        return target_skill

    source_root = get_loader().skills_root / source_name
    if not source_root.is_dir() or not (source_root / "__init__.py").is_file():
        raise HTTPException(status_code=400, detail=f"市场技能目录不可用：{source_name}")

    target_root = get_loader().skills_root / target_name
    if source_name != target_name:
        if target_root.exists():
            raise HTTPException(status_code=409, detail=f"目标目录已存在：{target_name}")
        shutil.copytree(source_root, target_root)

    description = (data.description or "").strip() or str(source_skill.get("description") or "")
    source_config = source_skill.get("config") if isinstance(source_skill.get("config"), dict) else {}
    install_config = {
        **source_config,
        "market_source_name": source_name,
        "market_source_owner": str(source_skill.get("owner_id") or ""),
    }
    try:
        installed = await svc.install(
            name=target_name,
            description=description,
            config=install_config,
            source="user",
            owner_id=effective_uid,
        )
        logger.info(
            "skills_marketplace install ok user=%s source=%s target=%s",
            effective_uid[:24],
            source_name,
            target_name,
        )
        return installed
    except ValueError as e:
        if source_name != target_name and target_root.exists():
            shutil.rmtree(target_root, ignore_errors=True)
        logger.warning(
            "skills_marketplace install failed user=%s source=%s target=%s err=%s",
            effective_uid[:24],
            source_name,
            target_name,
            e,
        )
        raise HTTPException(status_code=409, detail=str(e)) from e


@router.post("/upload", response_model=SkillResponse)
async def upload_skill_package(
    file: UploadFile = File(..., description="ZIP 技能包"),
    name: Optional[str] = Form(None, description="ZIP 根目录为包时必填；单文件夹 ZIP 须留空"),
    description: str = Form(""),
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    """
    上传 ZIP 安装技能：须含 __init__.py（Python 包）或 SKILL.md（标准 Agent 技能包），
    结构见 SkillLifecycleService.install_from_zip_bytes。
    """
    if not file.filename or not file.filename.lower().endswith(".zip"):
        raise HTTPException(status_code=400, detail="请上传 .zip 文件")
    raw = await file.read()
    if len(raw) > SKILL_UPLOAD_MAX_BYTES:
        raise HTTPException(status_code=400, detail=f"文件过大，上限 {SKILL_UPLOAD_MAX_BYTES // (1024 * 1024)}MB")
    logger.info(
        "skill_upload request filename=%s size=%s name_form=%s user_id=%s",
        file.filename,
        len(raw),
        name,
        effective_uid[:24],
    )
    svc = SkillLifecycleService(db, get_loader())
    try:
        return await svc.install_from_zip_bytes(
            raw,
            name_override=name,
            description=description or "",
            config=None,
            owner_id=effective_uid,
        )
    except ValueError as e:
        logger.warning("skill_upload rejected: %s", e)
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/usage")
async def skill_usage(
    days: int = Query(7, ge=1, le=90),
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    """近 N 日技能调用、采纳与场景白名单。工坊页使用，不拉整份用量总览。"""
    since = (datetime.now() - timedelta(days=days)).isoformat()
    view = await build_skill_usage_view(db, since=since, viewer_user_id=effective_uid)
    view["days"] = days
    return view


@router.post("/{name}/trial")
async def trial_skill(
    name: str,
    data: SkillTrialRequest,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    """按输入字段试跑。先记一条 workshop run，再走统一执行入口。"""
    svc = SkillLifecycleService(db, get_loader())
    skill_row = await svc.get_skill(name)
    if not skill_row or not skill_installation_visible(skill_row.get("owner_id"), effective_uid):
        raise HTTPException(status_code=404, detail=f"Skill '{name}' not found")
    if not skill_row.get("enabled"):
        raise HTTPException(status_code=400, detail=f"技能未启用：{name}")

    run_id = str(uuid.uuid4())
    fields = data.fields if isinstance(data.fields, dict) else {}
    context = dict(fields)
    collection = (data.collection_name or "").strip()
    if collection:
        context["collection_name"] = collection
    context["tphermes_run_id"] = run_id
    policy = {
        "mode": "allowed_list",
        "allowed": [name],
        "preferred": [name],
        "forbidden": [],
        "allow_agent_free_choice": False,
    }
    logger.info("skill_trial start skill=%s user=%s run_id=%s", name, effective_uid[:24], run_id)
    await create_run(
        db,
        run_id=run_id,
        project_id=None,
        entrypoint="workshop",
        user_id=effective_uid,
        request_json=json.dumps({"skill": name, "context_keys": sorted(context.keys())}, ensure_ascii=False),
        snapshot_json="{}",
        skills_policy_json=json.dumps(policy, ensure_ascii=False),
    )
    try:
        skill = get_loader().load(name)
        result = await execute_workshop_skill_generate(skill, context)
    except Exception as exc:
        logger.warning("skill_trial failed skill=%s run_id=%s err=%s", name, run_id, exc)
        await finalize_run(
            db,
            run_id=run_id,
            assistant_content="",
            status="failed",
            response_metadata={"skill": name, "error": str(exc)},
            validation=None,
            error_message=str(exc),
            duration_ms=None,
            project_id=None,
            template_id=None,
            save_output=False,
        )
        raise HTTPException(status_code=500, detail=f"试跑失败：{exc}") from exc

    if not isinstance(result, dict):
        result = {"content": str(result), "status": "succeeded"}
    status = str(result.get("status") or ("failed" if result.get("success") is False else "succeeded"))
    content = result.get("content")
    text = content if isinstance(content, str) else ("" if content is None else json.dumps(content, ensure_ascii=False))
    await finalize_run(
        db,
        run_id=run_id,
        assistant_content=text,
        status="failed" if status == "failed" else "completed",
        response_metadata={
            "skill": name,
            "execution_type": result.get("execution_type"),
            "fallback_reason": result.get("fallback_reason"),
            "missing_fields": result.get("missing_fields") or [],
        },
        validation=None,
        error_message=str(result.get("error") or "") or None,
        duration_ms=None,
        project_id=None,
        template_id=None,
        save_output=bool(text.strip()) and status != "failed",
        output_title=str(skill_row.get("config", {}).get("display_name") or name) if isinstance(skill_row.get("config"), dict) else name,
    )
    logger.info("skill_trial done skill=%s run_id=%s status=%s", name, run_id, status)
    return {
        "run_id": run_id,
        "skill": name,
        "status": status,
        "content": text or None,
        "error": result.get("error"),
        "missing_fields": result.get("missing_fields") or [],
        "suggested_collection": result.get("suggested_collection"),
        "execution_type": result.get("execution_type"),
        "fallback_reason": result.get("fallback_reason"),
    }


@router.get("/{name}", response_model=SkillResponse)
async def get_skill(
    name: str,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    """获取单个 Skill 详情"""
    svc = SkillLifecycleService(db, get_loader())
    skill = await svc.get_skill(name)
    if not skill:
        raise HTTPException(status_code=404, detail=f"Skill '{name}' not found")
    if not skill_installation_visible(skill.get("owner_id"), effective_uid):
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
            owner_id="",
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


@router.patch("/{name}/publish-global", response_model=SkillResponse)
async def publish_skill_global(
    name: str,
    data: SkillPublishGlobalRequest,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    """仅管理员可将个人技能发布为全员可见（owner_id 置空）。"""
    if not (is_global_admin_user(effective_uid) or effective_uid == "default"):
        raise HTTPException(status_code=403, detail="仅管理员可执行发布全员")
    if data.publish is not True:
        raise HTTPException(status_code=400, detail="当前仅支持发布全员")
    svc = SkillLifecycleService(db, get_loader())
    skill = await svc.get_skill(name)
    if not skill:
        raise HTTPException(status_code=404, detail=f"Skill '{name}' not found")
    owner = str(skill.get("owner_id") or "").strip()
    if not owner:
        return skill
    db_skill = await svc._get_db_skill(name)
    if not db_skill:
        raise HTTPException(status_code=404, detail=f"Skill '{name}' not found")
    db_skill.owner_id = ""
    await db.commit()
    await db.refresh(db_skill)
    logger.info(
        "skills_publish_global ok admin=%s skill=%s owner_from=%s",
        effective_uid[:24],
        name,
        owner[:24],
    )
    return svc._skill_to_dict(db_skill)


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


@router.get("/{name}/package")
async def get_skill_package(
    name: str,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    """列出技能包目录树与标准布局符合情况。"""
    _, root = await _resolve_skill_package_root(name, db, effective_uid)
    try:
        return list_package(root, name)
    except SkillPackageError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/{name}/package/file")
async def get_skill_package_file(
    name: str,
    path: str = Query(..., description="相对技能根目录的文件路径"),
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    """读取技能包内单个文件（文本）。"""
    _, root = await _resolve_skill_package_root(name, db, effective_uid)
    try:
        return read_package_file(root, path)
    except SkillPackageError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.put("/{name}/package/file")
async def put_skill_package_file(
    name: str,
    data: SkillPackageFileWriteRequest,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    """保存技能包内文本文件。"""
    _, root = await _resolve_skill_package_root(name, db, effective_uid)
    try:
        return write_package_file(root, data.path, data.content)
    except SkillPackageError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/{name}/package/init-skill-md")
async def post_init_skill_md(
    name: str,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    """若缺失则创建标准 SKILL.md 模板。"""
    skill, root = await _resolve_skill_package_root(name, db, effective_uid)
    try:
        return init_skill_md(root, name, skill.get("description") or "")
    except SkillPackageError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/{name}/package/layout-item")
async def post_create_layout_item(
    name: str,
    data: SkillLayoutItemRequest,
    db: AsyncSession = Depends(get_db),
    effective_uid: str = Depends(get_effective_user_id),
):
    """创建标准布局中缺失的一项（文件或目录）。"""
    skill, root = await _resolve_skill_package_root(name, db, effective_uid)
    try:
        return create_layout_item(
            root,
            name,
            data.item,
            skill.get("description") or "",
        )
    except SkillPackageError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


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


@router.post("/{name}/versions/{version}/restore")
async def restore_skill_version(
    name: str,
    version: str,
    db: AsyncSession = Depends(get_db),
):
    """用指定快照覆盖当前技能目录，并把版本指针拨回该快照。"""
    lifecycle = SkillLifecycleService(db, get_loader())
    try:
        restored = await lifecycle.restore_version(name, version)
    except SkillNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    logger.info("skill_restore via api name=%s version=%s", name, version)
    return restored
