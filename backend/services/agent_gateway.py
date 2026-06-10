"""
将 OrchestrationPayload 适配为 Hermes-agent OpenAI 兼容请求。
"""

from __future__ import annotations

import json
import os
from typing import Any

from backend.schemas.orchestration import OrchestrationPayload, TaskInputPayload

ORCHESTRATION_MARKER_BEGIN = "<<<ORCHESTRATION_JSON_BEGIN>>>"
ORCHESTRATION_MARKER_END = "<<<ORCHESTRATION_JSON_END>>>"


def orchestration_mode() -> str:
    return os.getenv("HERMES_ORCHESTRATION_MODE", "prompt").strip().lower()


def _build_orchestration_guidance(payload: OrchestrationPayload) -> str:
    knowledge_collections = [c for c in payload.knowledge.collections if c]
    preferred_skills = [s for s in payload.skills.preferred if s]
    allowed_skills = [s for s in payload.skills.allowed if s]
    candidate_skills = preferred_skills or allowed_skills

    lines = [
        "你是 TPDHermes 编排执行代理。你必须优先遵循 orchestration 中的边界、模板和技能策略。",
        "用户自然语言需求在对话消息中给出；不要在未授权时编造事实。",
        "项目附件与输出沉淀已写入 orchestration.knowledge.collections 中的 project.*.kb 集合；"
        "需要引用时请调用 kb_query / kb_get_entry 按需检索，不要假设 prompt 中已包含全文。",
        "知识库 collection_name 必须与 kb_list_collections 返回的完整名称完全一致"
        "（如 public.structured_tech.geely_tech），禁止省略 public./project. 前缀或使用短名 geely_tech。",
        "kb_query 的 query 优先使用文档中的产品代号、技术缩写、英文标识（如 GEA、Flyme），"
        "避免仅用营销口号或空泛词；若 count 为 0，应换用更具体的检索词重试，勿直接编造正文。",
    ]

    if knowledge_collections:
        lines.append(
            "当前知识检索范围仅限于这些 collections："
            + ", ".join(knowledge_collections)
            + "。"
        )

    if candidate_skills:
        lines.append(
            "当前可优先使用的 skills："
            + ", ".join(candidate_skills)
            + "。"
        )

    should_prefer_kb_skill = bool(knowledge_collections and candidate_skills)
    if should_prefer_kb_skill:
        lines.extend(
            [
                "当用户要求生成模板化内容、结构化文稿、发言稿、一页纸、短视频脚本，或明确要求结合知识库生成内容时，优先调用 `workshop_generate_from_kb`。",
                "调用要求：`collection_name` 必须从 orchestration.knowledge.collections 中原样复制（先 kb_list_collections 核对），"
                "`skill_name` 必须从 orchestration.skills.preferred/allowed 中选择。",
                "为 `query` 提炼文档实词检索词（产品/技术标识优先，勿单独使用口号）；"
                "`context` 须为 JSON 对象（勿传字符串）；仅传入需覆盖字段如 tone、cta、style。",
                "若 kb 返回 count=0，先换 query 或核对 collection_name 是否完整，再降级 kb_query + workshop_generate。",
            ]
        )

    if payload.output.must_follow_template or payload.output.template_id:
        lines.append("当前输出必须尽量遵循模板或结构要求，优先产出结构完整的模板化结果。")
    if payload.output.required_sections:
        lines.append(
            "输出至少覆盖这些 section："
            + ", ".join(payload.output.required_sections)
            + "。"
        )

    run_id = (payload.execution.run_id or "").strip()
    if run_id:
        lines.extend(
            [
                f"当前编排 run_id={run_id}。调用 kb_query 或 kb_get_entry 时必须传入 tphermes_run_id={run_id}。",
                "引用知识库事实时，必须在对应句末添加 [^N] 标记（N 为 kb_query/kb_get_entry 返回结果中的 ref 字段，从 1 开始）；"
                "涉及多条 KB 事实时每个要点都须标注。",
                "无检索依据的内容不得添加 [^N]；同一 chunk 复用同一 ref；不要自行编写来源脚注正文。",
            ]
        )

    return " ".join(lines)


def _build_workshop_agent_guidance(
    payload: OrchestrationPayload,
    *,
    skill_name: str,
    run_id: str,
    task_input: dict[str, Any] | None = None,
) -> str:
    knowledge_collections = [c for c in payload.knowledge.collections if c]
    project_id = payload.project.id if payload.project.id != "none" else ""
    lines = [
        "【结果工坊强制流程】你必须通过 MCP 工具完成生成，禁止跳过工具直接输出最终正文。",
        f"固定 skill_name={skill_name}，不得改用其他技能。",
        f"调用 workshop_generate 或 workshop_generate_from_kb 时，必须传入 tphermes_run_id={run_id}（工具顶层参数或 context 字段），"
        f"并包含 project_id={project_id}、scenario_id={payload.scenario.id}。",
    ]
    if task_input:
        lines.append("context 还须包含 task_input 对象（与编排合同一致）。")
    if knowledge_collections:
        lines.append(
            "优先调用 workshop_generate_from_kb：collection_name 必须从 "
            + ", ".join(knowledge_collections)
            + " 中原样复制（完整名，含 public./project. 前缀）；"
            f"project_id={project_id or 'null'}；"
            "query 用文档实词；context 为对象勿传字符串。"
        )
    else:
        lines.append(
            f"调用 workshop_generate(skill_name={skill_name!r}, context={{...}})。"
        )
    lines.append("工具成功后可用一句话摘要回复用户，但系统落库以工具返回内容为准。")
    return " ".join(lines)


def build_chat_completion_body(
    payload: OrchestrationPayload,
    messages: list[dict[str, Any]],
    model: str | None = None,
    *,
    workshop_skill_name: str | None = None,
    task_input: TaskInputPayload | None = None,
) -> dict[str, Any]:
    """
    构造转发给上游的 JSON body。
    - extra 模式：extra.orchestration 携带结构化编排（需上游支持）。
    - prompt 模式：在首条 system 中嵌入标记 JSON 块（默认）。
    """
    orch = payload.model_dump(mode="json")
    mode = orchestration_mode()
    model_name = model or os.getenv("HERMES_CHAT_MODEL", "hermes-agent")

    system_intro = _build_orchestration_guidance(payload)
    if payload.entrypoint == "workshop" and workshop_skill_name and payload.execution.run_id:
        ti_dict = task_input.model_dump(exclude_none=True) if task_input else None
        system_intro = (
            system_intro
            + " "
            + _build_workshop_agent_guidance(
                payload,
                skill_name=workshop_skill_name,
                run_id=payload.execution.run_id,
                task_input=ti_dict,
            )
        )

    if mode == "extra":
        body: dict[str, Any] = {
            "model": model_name,
            "messages": [
                {"role": "system", "content": system_intro},
                *messages,
            ],
            "stream": payload.execution.stream,
            "extra": {"orchestration": orch},
        }
        return body

    embedded = (
        f"{system_intro}\n\n"
        f"{ORCHESTRATION_MARKER_BEGIN}\n"
        f"{json.dumps(orch, ensure_ascii=False)}\n"
        f"{ORCHESTRATION_MARKER_END}"
    )
    return {
        "model": model_name,
        "messages": [
            {"role": "system", "content": embedded},
            *messages,
        ],
        "stream": payload.execution.stream,
    }


def parse_sse_data_line(data: str) -> tuple[str, dict[str, Any] | None]:
    """
    解析单条 OpenAI SSE data JSON，返回 (delta_text, raw_dict)。
    """
    if not data or data == "[DONE]":
        return "", None
    try:
        parsed = json.loads(data)
    except json.JSONDecodeError:
        return "", None
    if not isinstance(parsed, dict):
        return "", None
    if parsed.get("error"):
        return "", parsed
    choices = parsed.get("choices")
    text = ""
    if isinstance(choices, list) and choices:
        c0 = choices[0]
        if isinstance(c0, dict):
            delta = c0.get("delta")
            if isinstance(delta, dict) and isinstance(delta.get("content"), str):
                text = delta["content"]
            elif isinstance(c0.get("message"), dict):
                mc = c0["message"].get("content")
                if isinstance(mc, str):
                    text = mc
    if not text and isinstance(parsed.get("content"), str):
        text = parsed["content"]
    return text, parsed
