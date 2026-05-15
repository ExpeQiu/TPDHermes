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
from backend.models.project_scenario import ProjectScenario
from backend.models.scenario_profile import ScenarioProfile
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
    OutputValidationRules,
    ProjectConstraintsPayload,
    TaskExecuteRequest,
    TaskExecuteOverrides,
    normalize_skills_mode,
)

logger = logging.getLogger("tpdx.hermes")


class ProjectNotFoundError(Exception):
    """当请求携带 project_id 但数据库中不存在对应项目时抛出。"""

    def __init__(self, project_id: str):
        self.project_id = project_id


class WorkshopBindingError(Exception):
    """工坊入口：项目未绑定场景、缺少 project_id 或场景不可用。"""

    def __init__(self, detail: str):
        self.detail = detail


class ScenarioVersionMismatchError(Exception):
    """绑定记录的版本与场景当前版本不一致。"""

    def __init__(self, detail: str):
        self.detail = detail


# 回退用元数据（与历史前端 scenario id 对齐；持久化后以 DB 为准）
SCENARIO_CATALOG: dict[str, tuple[str, str, str]] = {
    "general": ("通用对话", "通用协作与问答", "collaborative"),
    "refine": ("结果优化", "对已有内容继续优化和重写", "task_oriented"),
    "tech-doc": ("技术文档写作", "输出结构化技术文档", "task_oriented"),
    "data-report": ("数据分析报告", "输出数据驱动型分析报告", "task_oriented"),
    "prd": ("产品需求文档", "输出 PRD 与需求规格", "task_oriented"),
    "marketing": ("营销推广文案", "输出传播型文案", "task_oriented"),
    "debug": ("故障排查报告", "输出故障复盘与改进", "task_oriented"),
    "kb-qa": ("知识库问答", "基于知识检索的问答", "collaborative"),
}


def _loads_json_obj(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        v = json.loads(raw)
        return v if isinstance(v, dict) else {}
    except json.JSONDecodeError:
        return {}


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


async def _load_scenario_profile(db: AsyncSession, scenario_id: str) -> ScenarioProfile | None:
    res = await db.execute(select(ScenarioProfile).where(ScenarioProfile.id == scenario_id))
    return res.scalar_one_or_none()


async def _ensure_workshop_binding(
    db: AsyncSession,
    *,
    project_id: str,
    scenario_id: str,
    profile_version: str,
) -> None:
    res = await db.execute(
        select(ProjectScenario).where(
            ProjectScenario.project_id == project_id,
            ProjectScenario.scenario_id == scenario_id,
            ProjectScenario.enabled == 1,
        )
    )
    row = res.scalar_one_or_none()
    if not row:
        raise WorkshopBindingError(f"项目在工坊中未启用该场景绑定: scenario_id={scenario_id}")
    if row.scenario_version != profile_version:
        raise ScenarioVersionMismatchError(
            f"场景版本不一致：绑定为 {row.scenario_version}，当前场景版本为 {profile_version}"
        )


def _catalog_meta(sid: str) -> tuple[str, str, str]:
    return SCENARIO_CATALOG.get(sid, (sid, "自定义场景", "task_oriented"))


def _merge_task_into_workshop_message(request: TaskExecuteRequest) -> str:
    base = request.user_message or ""
    ti = request.task_input
    if not ti:
        return base
    try:
        data = json.loads(base)
        if isinstance(data, dict):
            if ti.title is not None:
                data["title"] = ti.title
            if ti.background is not None:
                data["background"] = ti.background
            if ti.objective is not None:
                data["objective"] = ti.objective
            if ti.source_material is not None:
                data["source_material"] = ti.source_material
            if ti.tone is not None:
                data["tone"] = ti.tone
            if ti.extra is not None:
                data["extra"] = ti.extra
            if ti.keywords is not None:
                if isinstance(ti.keywords, list):
                    data["keywords"] = ", ".join(ti.keywords) if ti.keywords else ""
                else:
                    data["keywords"] = str(ti.keywords)
            return json.dumps(data, ensure_ascii=False)
    except (json.JSONDecodeError, TypeError):
        pass
    lines: list[str] = []
    if ti.title:
        lines.append(f"任务标题: {ti.title}")
    if ti.background:
        lines.append(f"背景补充: {ti.background}")
    if ti.objective:
        lines.append(f"任务目标: {ti.objective}")
    if ti.source_material:
        lines.append(f"素材/原文: {ti.source_material}")
    if ti.keywords:
        kw = ti.keywords if isinstance(ti.keywords, list) else [str(ti.keywords)]
        if kw:
            lines.append("关键词: " + ", ".join(kw))
    if ti.tone:
        lines.append(f"语气: {ti.tone}")
    if ti.extra:
        lines.append(f"附加要求: {ti.extra}")
    block = "\n".join(lines)
    b = base.strip()
    if block and b:
        return f"{block}\n\n{b}"
    return block or b


def _text_task_input_block(request: TaskExecuteRequest) -> str:
    return _merge_task_into_workshop_message(
        request.model_copy(update={"user_message": ""}),
    )


def _apply_profile_domain(base: OrchestrationDomain, pol: dict[str, Any]) -> OrchestrationDomain:
    d = base.model_dump()
    if isinstance(pol.get("technical_scope"), list):
        d["technical_scope"] = [str(x) for x in pol["technical_scope"]]
    if isinstance(pol.get("business_scope"), list):
        d["business_scope"] = [str(x) for x in pol["business_scope"]]
    if isinstance(pol.get("excluded_topics"), list):
        d["excluded_topics"] = [str(x) for x in pol["excluded_topics"]]
    if pol.get("terminology_policy") is not None:
        d["terminology_policy"] = str(pol["terminology_policy"])
    return OrchestrationDomain.model_validate(d)


def _apply_profile_knowledge(base: OrchestrationKnowledge, pol: dict[str, Any]) -> OrchestrationKnowledge:
    mode = pol.get("mode", base.mode)
    if mode not in ("restricted", "open"):
        mode = base.mode
    cols = pol.get("collections")
    ed = pol.get("eligible_domains")
    return OrchestrationKnowledge(
        mode=mode,  # type: ignore[arg-type]
        collections=list(cols) if isinstance(cols, list) else base.collections,
        project_bound=bool(pol.get("project_bound", base.project_bound)),
        top_k=int(pol.get("top_k", base.top_k)),
        fallback_policy=str(pol.get("fallback_policy", base.fallback_policy)),
        eligible_domains=list(ed) if isinstance(ed, list) else base.eligible_domains,
    )


def _apply_profile_skills(base: OrchestrationSkills, pol: dict[str, Any]) -> OrchestrationSkills:
    raw_mode = pol.get("mode", base.mode)
    mode = normalize_skills_mode(str(raw_mode) if raw_mode is not None else None)
    al = pol.get("allowed")
    pr = pol.get("preferred")
    fb = pol.get("forbidden")
    return OrchestrationSkills(
        mode=mode,
        allowed=list(al) if isinstance(al, list) else base.allowed,
        preferred=list(pr) if isinstance(pr, list) else base.preferred,
        forbidden=list(fb) if isinstance(fb, list) else base.forbidden,
        allow_agent_free_choice=bool(pol.get("allow_agent_free_choice", base.allow_agent_free_choice)),
    )


def _apply_profile_output(base: OrchestrationOutput, pol: dict[str, Any]) -> OrchestrationOutput:
    vr_in = pol.get("validation_rules")
    vr: OutputValidationRules | None = base.validation_rules
    if isinstance(vr_in, dict):
        vr = OutputValidationRules(
            must_have_headings=bool(vr_in.get("must_have_headings", True)),
            must_cite_sources=bool(vr_in.get("must_cite_sources", False)),
        )
    rs = pol.get("required_sections")
    if "template_id" in pol:
        tid_raw = pol.get("template_id")
        new_tid = str(tid_raw) if tid_raw else None
    else:
        new_tid = base.template_id
    return OrchestrationOutput(
        template_id=new_tid,
        format=str(pol.get("format", base.format)),
        must_follow_template=bool(pol.get("must_follow_template", base.must_follow_template)),
        required_sections=list(rs) if isinstance(rs, list) else base.required_sections,
        validation_rules=vr,
    )


async def assemble_payload(
    db: AsyncSession,
    request: TaskExecuteRequest,
) -> tuple[OrchestrationPayload, dict[str, Any]]:
    """
    assemble_payload 返回 (payload, snapshot_dict) 用于 orchestration_runs.snapshot_json。
    """
    request_id = f"req_{uuid.uuid4().hex[:12]}"
    entrypoint = request.entrypoint
    scenario_id = (request.scenario_id or "general").strip() or "general"

    effective_message = request.user_message or ""
    if entrypoint == "workshop":
        effective_message = _merge_task_into_workshop_message(request)
    else:
        ti_block = _text_task_input_block(request)
        if ti_block:
            effective_message = ti_block

    profile_row = await _load_scenario_profile(db, scenario_id)

    if entrypoint == "workshop":
        pid = (request.project_id or "").strip()
        if not pid or pid == "none":
            raise WorkshopBindingError("工坊入口必须提供有效的 project_id")
        if not profile_row:
            raise WorkshopBindingError(f"场景不存在或未入库: {scenario_id}")
        if profile_row.status == "disabled":
            raise WorkshopBindingError(f"场景已停用: {scenario_id}")
        await _ensure_workshop_binding(
            db,
            project_id=pid,
            scenario_id=scenario_id,
            profile_version=profile_row.version,
        )

    if profile_row:
        scenario = OrchestrationScenario(
            id=scenario_id,
            name=profile_row.name,
            goal=profile_row.goal,
            conversation_mode=profile_row.conversation_mode or "task_oriented",
        )
        scenario_profile_version = profile_row.version
    else:
        meta = _catalog_meta(scenario_id)
        scenario = OrchestrationScenario(
            id=scenario_id,
            name=meta[0],
            goal=meta[1],
            conversation_mode=meta[2],
        )
        scenario_profile_version = None

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

    base_preset = (profile_row.preset_instructions or "").strip() if profile_row else ""
    if pin:
        final_preset = pin
    elif base_preset:
        final_preset = base_preset
    else:
        final_preset = ""

    oin_req = (request.scenario_opening_hint or "").strip() or None
    oin_prof = (profile_row.opening_hint or "").strip() if profile_row and profile_row.opening_hint else None
    final_opening = oin_req or oin_prof

    scenario = scenario.model_copy(
        update={
            "preset_instructions": final_preset or None,
            "opening_hint": final_opening,
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
        eligible_domains=list(knowledge_defaults.get("eligible_domains", []))
        if isinstance(knowledge_defaults.get("eligible_domains"), list)
        else [],
    )

    skills = OrchestrationSkills(
        mode=normalize_skills_mode(str(skills_defaults.get("mode", "agent_select"))),
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

    if profile_row:
        domain = _apply_profile_domain(domain, _loads_json_obj(profile_row.domain_json))
        knowledge = _apply_profile_knowledge(knowledge, _loads_json_obj(profile_row.knowledge_policy_json))
        skills = _apply_profile_skills(skills, _loads_json_obj(profile_row.skills_policy_json))
        output = _apply_profile_output(output, _loads_json_obj(profile_row.output_policy_json))

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
            if kd.eligible_domains is not None:
                knowledge = knowledge.model_copy(update={"eligible_domains": kd.eligible_domains})
        if overrides.skills:
            sk = overrides.skills
            if sk.mode is not None:
                skills = skills.model_copy(update={"mode": normalize_skills_mode(sk.mode)})
            if sk.allowed is not None:
                skills = skills.model_copy(update={"allowed": sk.allowed})
            if sk.preferred is not None:
                skills = skills.model_copy(update={"preferred": sk.preferred})
            if sk.allow_agent_free_choice is not None:
                skills = skills.model_copy(update={"allow_agent_free_choice": sk.allow_agent_free_choice})
        if overrides.domain:
            merged_domain = {**domain.model_dump(), **overrides.domain}
            domain = OrchestrationDomain.model_validate(merged_domain)

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
        user_input=OrchestrationUserInput(message=effective_message),
    )

    snapshot = {
        "request_id": request_id,
        "project_id": proj.id,
        "scenario_id": scenario_id,
        "scenario_version": scenario_profile_version,
        "template_id": output.template_id,
        "entrypoint": entrypoint,
    }
    logger.info(
        "orchestration assembled request_id=%s entrypoint=%s project=%s scenario=%s ver=%s",
        request_id,
        entrypoint,
        proj.id,
        scenario_id,
        scenario_profile_version,
    )
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
