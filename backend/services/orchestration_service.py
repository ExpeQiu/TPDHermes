"""
从项目、场景、项目配置与 overrides 组装 OrchestrationPayload。
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.project import Project
from backend.models.project_config import ProjectConfig
from backend.schemas.orchestration import (
    ChatTurnMessage,
    OrchestrationDomain,
    OrchestrationExecution,
    OrchestrationKnowledge,
    OrchestrationOutput,
    OrchestrationPayload,
    OrchestrationProject,
    OrchestrationScenario,
    OrchestrationSkills,
    OrchestrationUserInput,
    ProjectConstraintsPayload,
    TaskExecuteRequest,
    TaskExecuteOverrides,
)

logger = logging.getLogger("tpdx.hermes")


class ProjectNotFoundError(Exception):
    """当请求携带 project_id 但数据库中不存在对应项目时抛出。"""

    def __init__(self, project_id: str):
        self.project_id = project_id


# 快速创作 / 默认场景（与前端 create 页 scenario id 对齐）
SCENARIO_CATALOG: dict[str, tuple[str, str, str]] = {
    "general": ("通用对话", "通用协作与问答", "collaborative"),
    "tech-doc": ("技术文档写作", "输出结构化技术文档", "task_oriented"),
    "data-report": ("数据分析报告", "输出数据驱动型分析报告", "task_oriented"),
    "prd": ("产品需求文档", "输出 PRD 与需求规格", "task_oriented"),
    "marketing": ("营销推广文案", "输出传播型文案", "task_oriented"),
    "debug": ("故障排查报告", "输出故障复盘与改进", "task_oriented"),
    "kb-qa": ("知识库问答", "基于知识检索的问答", "collaborative"),
}


def _parse_constraints(raw: str | None) -> ProjectConstraintsPayload | None:
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    tone = data.get("tone")
    length = data.get("length")
    language = data.get("language")
    if tone is None and length is None and language is None:
        return None
    return ProjectConstraintsPayload(
        tone=str(tone) if tone is not None else None,
        length=str(length) if length is not None else None,
        language=str(language) if language is not None else "zh-CN",
    )


def _domain_from_project_constraints(raw: str | None) -> OrchestrationDomain:
    if not raw:
        return OrchestrationDomain()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return OrchestrationDomain()
    if not isinstance(data, dict):
        return OrchestrationDomain()
    tech = data.get("technical_scope")
    biz = data.get("business_scope")
    excluded = data.get("excluded_topics")
    policy = data.get("terminology_policy")
    return OrchestrationDomain(
        technical_scope=list(tech) if isinstance(tech, list) else [],
        business_scope=list(biz) if isinstance(biz, list) else [],
        excluded_topics=list(excluded) if isinstance(excluded, list) else [],
        terminology_policy=str(policy) if policy is not None else "tpd_standard",
    )


async def load_project_config_defaults(db: AsyncSession, project_id: str) -> dict[str, Any]:
    res = await db.execute(select(ProjectConfig).where(ProjectConfig.project_id == project_id))
    row = res.scalar_one_or_none()
    if not row or not row.defaults_json:
        return {}
    try:
        data = json.loads(row.defaults_json)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


async def assemble_payload(
    db: AsyncSession,
    request: TaskExecuteRequest,
) -> tuple[OrchestrationPayload, dict[str, Any]]:
    """
    返回 (payload, snapshot_dict) 用于 orchestration_runs.snapshot_json。
    """
    request_id = f"req_{uuid.uuid4().hex[:12]}"
    entrypoint = request.entrypoint
    scenario_id = request.scenario_id or "general"
    scenario_meta = SCENARIO_CATALOG.get(
        scenario_id,
        (scenario_id, "自定义场景", "task_oriented"),
    )
    scenario = OrchestrationScenario(
        id=scenario_id,
        name=scenario_meta[0],
        goal=scenario_meta[1],
        conversation_mode=scenario_meta[2],
    )
    pin = (request.scenario_preset_instructions or "").strip()
    first_system: str | None = None
    if request.messages:
        for m in request.messages:
            if m.role == "system" and m.content.strip():
                first_system = m.content.strip()
                break
    if not pin and first_system:
        pin = first_system.strip()
        if pin.startswith("场景预设："):
            pin = pin.replace("场景预设：", "", 1).strip()
        elif pin.startswith("场景预设:"):
            pin = pin.replace("场景预设:", "", 1).strip()
    oin = (request.scenario_opening_hint or "").strip() or None
    scenario = scenario.model_copy(
        update={
            "preset_instructions": pin or None,
            "opening_hint": oin or None,
        }
    )

    overrides: TaskExecuteOverrides | None = request.overrides
    defaults: dict[str, Any] = {}
    project_row: Project | None = None

    if request.project_id:
        res = await db.execute(select(Project).where(Project.id == request.project_id))
        project_row = res.scalar_one_or_none()
        if project_row:
            defaults = await load_project_config_defaults(db, project_row.id)

    if request.project_id and str(request.project_id).strip() and not project_row:
        raise ProjectNotFoundError(str(request.project_id).strip())

    if project_row:
        proj = OrchestrationProject(
            id=project_row.id,
            name=project_row.name,
            background=project_row.background,
            audience=project_row.audience,
            constraints=_parse_constraints(project_row.constraints),
        )
        domain = _domain_from_project_constraints(project_row.constraints)
        if project_row.default_template_id:
            if overrides is None:
                overrides = TaskExecuteOverrides(template_id=project_row.default_template_id)
            elif overrides.template_id is None:
                overrides = overrides.model_copy(update={"template_id": project_row.default_template_id})
    else:
        proj = OrchestrationProject(
            id="none",
            name="未绑定项目",
            background=None,
            audience=None,
            constraints=None,
        )
        domain = OrchestrationDomain()

    # defaults_json 可包含 knowledge, skills, output, domain 片段
    knowledge_defaults = defaults.get("knowledge") if isinstance(defaults.get("knowledge"), dict) else {}
    skills_defaults = defaults.get("skills") if isinstance(defaults.get("skills"), dict) else {}
    output_defaults = defaults.get("output") if isinstance(defaults.get("output"), dict) else {}
    domain_defaults = defaults.get("domain") if isinstance(defaults.get("domain"), dict) else {}

    knowledge = OrchestrationKnowledge(
        mode=str(knowledge_defaults.get("mode", "restricted")),
        collections=list(knowledge_defaults.get("collections", []))
        if isinstance(knowledge_defaults.get("collections"), list)
        else [],
        project_bound=bool(knowledge_defaults.get("project_bound", True)),
        top_k=int(knowledge_defaults.get("top_k", 5)),
        fallback_policy=str(knowledge_defaults.get("fallback_policy", "cache_allowed")),
    )

    skills = OrchestrationSkills(
        mode=str(skills_defaults.get("mode", "agent_select")),
        allowed=list(skills_defaults.get("allowed", []))
        if isinstance(skills_defaults.get("allowed"), list)
        else [],
        preferred=list(skills_defaults.get("preferred", []))
        if isinstance(skills_defaults.get("preferred"), list)
        else [],
        forbidden=list(skills_defaults.get("forbidden", []))
        if isinstance(skills_defaults.get("forbidden"), list)
        else [],
        allow_agent_free_choice=bool(skills_defaults.get("allow_agent_free_choice", True)),
    )

    output = OrchestrationOutput(
        template_id=output_defaults.get("template_id") if isinstance(output_defaults.get("template_id"), str) else None,
        format=str(output_defaults.get("format", "markdown")),
        must_follow_template=bool(output_defaults.get("must_follow_template", False)),
        required_sections=list(output_defaults.get("required_sections", []))
        if isinstance(output_defaults.get("required_sections"), list)
        else [],
    )

    if domain_defaults:
        domain = domain.model_copy(
            update={
                "technical_scope": list(domain_defaults.get("technical_scope", domain.technical_scope))
                if isinstance(domain_defaults.get("technical_scope"), list)
                else domain.technical_scope,
                "business_scope": list(domain_defaults.get("business_scope", domain.business_scope))
                if isinstance(domain_defaults.get("business_scope"), list)
                else domain.business_scope,
            }
        )

    # overrides 应用
    if overrides:
        if overrides.template_id:
            output = output.model_copy(update={"template_id": overrides.template_id})
        if overrides.output:
            if overrides.output.template_id:
                output = output.model_copy(update={"template_id": overrides.output.template_id})
            if overrides.output.required_sections is not None:
                output = output.model_copy(update={"required_sections": overrides.output.required_sections})
            if overrides.output.must_follow_template is not None:
                output = output.model_copy(update={"must_follow_template": overrides.output.must_follow_template})
        if overrides.knowledge:
            kd = overrides.knowledge
            if kd.collections is not None:
                knowledge = knowledge.model_copy(update={"collections": kd.collections})
            if kd.mode is not None:
                knowledge = knowledge.model_copy(update={"mode": kd.mode})  # type: ignore[arg-type]
            if kd.top_k is not None:
                knowledge = knowledge.model_copy(update={"top_k": kd.top_k})
            if kd.project_bound is not None:
                knowledge = knowledge.model_copy(update={"project_bound": kd.project_bound})
        if overrides.skills:
            sk = overrides.skills
            if sk.mode is not None:
                skills = skills.model_copy(update={"mode": sk.mode})  # type: ignore[arg-type]
            if sk.allowed is not None:
                skills = skills.model_copy(update={"allowed": sk.allowed})
            if sk.preferred is not None:
                skills = skills.model_copy(update={"preferred": sk.preferred})
            if sk.allow_agent_free_choice is not None:
                skills = skills.model_copy(update={"allow_agent_free_choice": sk.allow_agent_free_choice})
        if overrides.domain:
            merged_domain = {**domain.model_dump(), **overrides.domain}
            domain = OrchestrationDomain.model_validate(merged_domain)

    # 工坊入口：强制 manual_only + 白名单（由请求方传入 overrides.skills.allowed）
    if entrypoint == "workshop":
        skills = skills.model_copy(update={"mode": "manual_only", "allow_agent_free_choice": False})

    execution = OrchestrationExecution(stream=request.stream, trace=True, save_output=True, save_run_log=True)

    payload = OrchestrationPayload(
        request_id=request_id,
        entrypoint=entrypoint,  # type: ignore[arg-type]
        project=proj,
        scenario=scenario,
        domain=domain,
        knowledge=knowledge,
        skills=skills,
        output=output,
        execution=execution,
        user_input=OrchestrationUserInput(message=request.user_message),
    )

    snapshot = {
        "request_id": request_id,
        "project_id": proj.id,
        "scenario_id": scenario_id,
        "template_id": output.template_id,
        "entrypoint": entrypoint,
    }
    logger.info("orchestration assembled request_id=%s entrypoint=%s project=%s", request_id, entrypoint, proj.id)
    return payload, snapshot


def merge_chat_messages(
    prior: list[ChatTurnMessage] | None,
    user_message: str,
) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    if prior:
        for m in prior:
            if m.role == "system":
                continue
            out.append({"role": m.role, "content": m.content})
    out.append({"role": "user", "content": user_message})
    return out
