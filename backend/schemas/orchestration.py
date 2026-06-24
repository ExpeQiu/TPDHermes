"""
编排合同：TPDHermes 与 Hermes-agent 之间的结构化协议（对齐 guide/编排改造方案.md）。
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


SkillsMode = Literal["manual_only", "allowed_list", "preferred_list", "agent_select"]


def normalize_skills_mode(raw: str | None) -> SkillsMode:
    """兼容历史 forbidden_list 等取值。"""
    if raw is None or raw == "":
        return "agent_select"
    if raw == "forbidden_list":
        return "allowed_list"
    if raw in ("manual_only", "allowed_list", "preferred_list", "agent_select"):
        return raw  # type: ignore[return-value]
    return "agent_select"


class ProjectConstraintsPayload(BaseModel):
    """项目侧长期约束（可与 projects.constraints JSON 对齐）。"""

    tone: str | None = None
    length: str | None = None
    language: str | None = "zh-CN"


class OrchestrationProject(BaseModel):
    id: str
    name: str
    background: str | None = None
    audience: str | None = None
    constraints: ProjectConstraintsPayload | None = None


class OrchestrationScenario(BaseModel):
    id: str
    name: str
    goal: str | None = None
    conversation_mode: str | None = "task_oriented"
    preset_instructions: str | None = Field(
        default=None,
        description="快速创作等入口的详细人设/风格说明，进入编排合同",
    )
    opening_hint: str | None = Field(default=None, description="建议开场或任务提示")


class OrchestrationDomain(BaseModel):
    technical_scope: list[str] = Field(default_factory=list)
    business_scope: list[str] = Field(default_factory=list)
    terminology_policy: str | None = "tpd_standard"
    excluded_topics: list[str] = Field(default_factory=list)


class OrchestrationKnowledge(BaseModel):
    mode: Literal["restricted", "open"] = "restricted"
    collections: list[str] = Field(default_factory=list)
    project_bound: bool = True
    top_k: int = 5
    fallback_policy: str = "cache_allowed"
    eligible_domains: list[str] = Field(
        default_factory=list,
        description="可选：仅当 KB metadata.domain 属于该列表时优先纳入（上游检索支持时生效；未实现前作文档约定）",
    )


class OrchestrationSkills(BaseModel):
    mode: SkillsMode = "agent_select"
    allowed: list[str] = Field(default_factory=list)
    preferred: list[str] = Field(default_factory=list)
    forbidden: list[str] = Field(default_factory=list)
    allow_agent_free_choice: bool = False

    @field_validator("mode", mode="before")
    @classmethod
    def _coerce_skills_mode(cls, v: object) -> SkillsMode:
        return normalize_skills_mode(str(v) if v is not None else None)


class OutputValidationRules(BaseModel):
    must_have_headings: bool = True
    must_cite_sources: bool = False


class OrchestrationOutput(BaseModel):
    template_id: str | None = None
    format: str = "markdown"
    must_follow_template: bool = False
    required_sections: list[str] = Field(default_factory=list)
    validation_rules: OutputValidationRules | None = None


class OrchestrationExecution(BaseModel):
    stream: bool = True
    trace: bool = True
    save_output: bool = True
    save_run_log: bool = True
    run_id: str | None = Field(default=None, description="编排 run 主键，工坊 Agent 模式写入 MCP context")


class OrchestrationActor(BaseModel):
    """当前调用者（审计、下游限权）。"""

    user_id: str
    role: str = "tenant_admin"


class OrchestrationUserInput(BaseModel):
    message: str


class OrchestrationPayload(BaseModel):
    """运行时核心编排对象。"""

    request_id: str
    entrypoint: Literal["chat", "create", "workshop", "quick_create", "project"] = "chat"
    project: OrchestrationProject
    scenario: OrchestrationScenario
    domain: OrchestrationDomain = Field(default_factory=OrchestrationDomain)
    knowledge: OrchestrationKnowledge = Field(default_factory=OrchestrationKnowledge)
    skills: OrchestrationSkills = Field(default_factory=OrchestrationSkills)
    output: OrchestrationOutput = Field(default_factory=OrchestrationOutput)
    execution: OrchestrationExecution = Field(default_factory=OrchestrationExecution)
    user_input: OrchestrationUserInput
    actor: OrchestrationActor | None = None


class TaskKnowledgeOverrides(BaseModel):
    collections: list[str] | None = None
    mode: str | None = None
    top_k: int | None = None
    project_bound: bool | None = None
    eligible_domains: list[str] | None = None


class TaskSkillsOverrides(BaseModel):
    mode: str | None = None
    allowed: list[str] | None = None
    preferred: list[str] | None = None
    allow_agent_free_choice: bool | None = None


class TaskOutputOverrides(BaseModel):
    template_id: str | None = None
    required_sections: list[str] | None = None
    must_follow_template: bool | None = None


class TaskExecuteOverrides(BaseModel):
    template_id: str | None = None
    knowledge: TaskKnowledgeOverrides | None = None
    skills: TaskSkillsOverrides | None = None
    output: TaskOutputOverrides | None = None
    domain: dict[str, Any] | None = None


class ChatTurnMessage(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str


class TaskInputPayload(BaseModel):
    """结果工坊等入口的结构化任务增量（与 user_message 合并）。"""

    title: str | None = None
    background: str | None = None
    objective: str | None = None
    source_material: str | None = None
    keywords: list[str] | str | None = None
    tone: str | None = None
    extra: str | None = None


class TaskExecuteRequest(BaseModel):
    """POST /tasks/execute 请求体（对齐方案第十八章）。"""

    entrypoint: Literal["chat", "create", "workshop", "quick_create", "project"] = "chat"
    user_id: str | None = Field(default=None, description="显式用户 ID（可与 X-User-ID 双写）")
    user_role: str | None = Field(default=None, description="可选，默认取 X-User-Role")
    project_id: str | None = None
    scenario_id: str | None = "general"
    chat_mode: Literal["co_create", "doc_optimize"] | None = Field(
        default=None,
        description="/chat 场景：co_create 自由共创，doc_optimize 文稿优化（须 source_output_id）",
    )
    user_message: str = ""
    task_input: TaskInputPayload | None = None
    scenario_preset_instructions: str | None = Field(
        default=None,
        description="与 /create 场景卡对齐的详细设定，写入 scenario.preset_instructions",
    )
    scenario_opening_hint: str | None = Field(
        default=None,
        description="建议开场提示，写入 scenario.opening_hint",
    )
    source_output_id: str | None = Field(
        default=None,
        description="结果优化：来源输出 ID，服务端将拉取正文写入 task_input.source_material（若尚未填写）",
    )
    overrides: TaskExecuteOverrides | None = None
    stream: bool = True
    messages: list[ChatTurnMessage] | None = None
    session_id: str | None = Field(default=None, description="项目共创关联会话 ID")
    project_file_ids: list[str] | None = Field(
        default=None,
        description="项目共创本轮引用文件 ID 列表",
    )
    pinned_file_ids: list[str] | None = Field(
        default=None,
        description="项目共创固定引用文件 ID 列表",
    )


class AgentTaskMetadata(BaseModel):
    """从 Agent 响应或流末尾解析的元信息（可逐步增强）。"""

    used_collections: list[str] = Field(default_factory=list)
    used_skills: list[str] = Field(default_factory=list)
    template_id: str | None = None
    citations: list[str] = Field(default_factory=list)
    run_id: str | None = None
