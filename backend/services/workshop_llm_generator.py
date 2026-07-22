"""工坊模版类技能：基于 KB 上下文 LLM 生成可交付成稿（非模版填空）。"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from pathlib import Path
from typing import Any

import httpx

from backend.env_policy import allow_missing_chat_upstream
from backend.services.skill_loader import Skill

logger = logging.getLogger("tpdx.hermes.workshop_llm")


def workshop_llm_generation_enabled() -> bool:
    raw = os.getenv("WORKSHOP_LLM_GENERATION", "true").strip().lower()
    return raw not in ("0", "false", "no", "off")


def should_generate_llm_deliverable(skill: Skill) -> bool:
    if not workshop_llm_generation_enabled():
        return False
    template = skill.get_template()
    return bool(template and str(template).strip())


def _skill_description(skill: Skill) -> str:
    path = skill.skill_path
    if path:
        try:
            from backend.services.skill_package import resolve_skill_discovery

            disc = resolve_skill_discovery(Path(path), skill.name)
            selection = str(disc.get("selection") or disc.get("description") or "").strip()
            if selection:
                return selection
        except Exception:
            pass
        meta_path = Path(path) / "skill.json"
        if meta_path.is_file():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                desc = str(meta.get("description") or "").strip()
                if desc:
                    return desc
            except (json.JSONDecodeError, OSError):
                pass
    doc = (getattr(skill.__class__, "__doc__", None) or "").strip()
    return doc or skill.name


def _truncate(text: str, limit: int = 600) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _format_kb_block(context: dict[str, Any]) -> str:
    lines: list[str] = []
    results = context.get("knowledge_results")
    if isinstance(results, list):
        for idx, item in enumerate(results[:5], start=1):
            if not isinstance(item, dict):
                continue
            meta = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
            title = meta.get("title") or meta.get("doc_id") or meta.get("source") or f"条目{idx}"
            body = _truncate(str(item.get("content") or ""), 480)
            if body:
                lines.append(f"[^{idx}] {title}\n{body}")
    excerpt = str(context.get("knowledge_excerpt") or "").strip()
    if excerpt and not lines:
        lines.append(excerpt)
    return "\n\n".join(lines).strip()


def _format_task_input(context: dict[str, Any]) -> str:
    task_input = context.get("task_input")
    if not isinstance(task_input, dict):
        return ""
    parts: list[str] = []
    for key, label in (
        ("title", "任务标题"),
        ("background", "背景"),
        ("objective", "目标"),
        ("keywords", "关键词"),
        ("tone", "语气"),
        ("extra", "补充说明"),
    ):
        val = task_input.get(key)
        if val is None:
            continue
        text = str(val).strip()
        if text:
            parts.append(f"{label}：{text}")
    return "\n".join(parts)


def _build_llm_prompt(skill: Skill, context: dict[str, Any]) -> tuple[str, str]:
    template = skill.get_template() or ""
    template_hint = _truncate(template.replace("```", "\n"), 900)
    kb_block = _format_kb_block(context)
    task_block = _format_task_input(context)
    title = (
        str(context.get("title") or "").strip()
        or str(context.get("tech_name") or "").strip()
        or str(context.get("theme") or "").strip()
        or str(context.get("knowledge_query") or "").strip()
        or "交付文稿"
    )

    system = (
        "你是企业技术推广内容撰写专家。"
        "请根据提供的知识库资料与任务信息，输出可直接发布/宣讲的 Markdown 成稿。"
        "禁止输出模版说明、结构框架示例、占位符、写作注意事项或 meta 注释。"
        "正文须完整、连贯，可独立阅读。"
    )
    user_parts = [
        f"技能：{skill.name}（{_skill_description(skill)}）",
        f"建议标题：{title}",
    ]
    if task_block:
        user_parts.append(f"任务信息：\n{task_block}")
    if kb_block:
        user_parts.append(f"知识库资料（请基于事实撰写，勿臆造）：\n{kb_block}")
    else:
        mapped = {
            k: context[k]
            for k in (
                "tech_name",
                "slogan",
                "scene_pain",
                "tech_solution",
                "user_value",
                "cta",
                "theme",
                "hook",
                "tech_display",
            )
            if context.get(k)
        }
        if mapped:
            user_parts.append(f"结构化上下文：\n{json.dumps(mapped, ensure_ascii=False, indent=2)}")
    if template_hint:
        user_parts.append(
            "以下仅为内容结构参考（勿原样输出模版原文或其中的说明性段落）：\n"
            + template_hint
        )
    user_parts.append(
        "输出要求：\n"
        "1. 以 `# 标题` 开头\n"
        "2. 分段清晰，覆盖技能对应的交付结构（如发言稿含开场、方案、价值、收尾）\n"
        "3. 只输出 Markdown 正文，不要代码块包裹全文\n"
        "4. 不要出现「模板」「结构框架」「注意事项」等字样"
    )
    return system, "\n\n".join(user_parts)


def _strip_code_fence(text: str) -> str:
    cleaned = text.strip()
    match = re.match(r"^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$", cleaned, re.IGNORECASE)
    if match:
        return match.group(1).strip()
    return cleaned


def _resolve_chat_target() -> tuple[str, str] | None:
    url = os.getenv("HERMES_CHAT_API_URL", "").strip()
    if not url:
        return None
    api_key = os.getenv("HERMES_CHAT_API_KEY", "").strip()
    return url, api_key


def _resolve_chat_model() -> str:
    return os.getenv("HERMES_CHAT_MODEL", "").strip() or "hermes-agent"


def _extract_completion_text(payload: dict[str, Any]) -> str:
    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
        c0 = choices[0]
        if isinstance(c0, dict):
            message = c0.get("message")
            if isinstance(message, dict):
                content = message.get("content")
                if isinstance(content, str) and content.strip():
                    return content.strip()
            delta = c0.get("delta")
            if isinstance(delta, dict):
                dc = delta.get("content")
                if isinstance(dc, str) and dc.strip():
                    return dc.strip()
    content = payload.get("content")
    if isinstance(content, str) and content.strip():
        return content.strip()
    raise RuntimeError("empty_llm_response")


def _compose_fallback_deliverable(skill: Skill, context: dict[str, Any]) -> str:
    """无 LLM 上游时的结构化成稿兜底（非模版原文）。"""
    title = (
        str(context.get("title") or "").strip()
        or str(context.get("tech_name") or "").strip()
        or str(context.get("theme") or "").strip()
        or str(context.get("knowledge_query") or "").strip()
        or skill.name
    )
    kb_block = _format_kb_block(context)
    highlights = context.get("highlights") or context.get("tech_highlights") or []
    hl_lines: list[str] = []
    if isinstance(highlights, list):
        for item in highlights[:3]:
            if isinstance(item, dict):
                name = item.get("name") or item.get("highlight") or ""
                detail = item.get("scene_data") or item.get("user_benefit") or item.get("params") or ""
                if name or detail:
                    hl_lines.append(f"- **{name}**：{detail}".strip("："))

    scene = str(context.get("scene_pain") or context.get("hook") or "").strip()
    solution = str(context.get("tech_solution") or context.get("tech_display") or "").strip()
    value = str(context.get("user_value") or "").strip()
    cta = str(context.get("cta") or "欢迎进一步了解与交流。").strip()
    slogan = str(context.get("slogan") or "").strip()

    parts = [f"# {title}"]
    if slogan:
        parts.append(f"\n> {slogan}")
    parts.append("\n## 开场\n")
    if scene:
        parts.append(f"各位好。围绕{title}，我们先看一个真实场景：{scene}")
    elif kb_block:
        parts.append(f"各位好。今天分享与「{title}」相关的实践与价值。")
    else:
        parts.append(f"各位好。今天围绕{title}，分享核心方案与用户价值。")

    parts.append("\n\n## 方案与亮点\n")
    if solution:
        parts.append(solution)
    if hl_lines:
        parts.extend(["", *hl_lines])
    elif kb_block:
        parts.append(kb_block[:800])

    parts.append("\n\n## 用户价值\n")
    parts.append(value or "帮助团队减少重复摸索，更快形成可复用的技术推广内容。")

    parts.append("\n\n## 收尾\n")
    parts.append(cta)
    return "\n".join(parts).strip()


async def _call_llm(system: str, user: str) -> str:
    target = _resolve_chat_target()
    if not target:
        raise RuntimeError("chat_upstream_not_configured")
    url, api_key = target
    payload = {
        "model": _resolve_chat_model(),
        "stream": False,
        "max_tokens": max(1024, int(os.getenv("WORKSHOP_LLM_MAX_TOKENS", "4096"))),
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    timeout_s = max(15.0, float(os.getenv("WORKSHOP_LLM_TIMEOUT", "120")))
    timeout = httpx.Timeout(connect=10.0, read=timeout_s, write=30.0, pool=10.0)
    logger.info(
        "[workshop-llm] request skill_model=%s user_len=%s",
        payload["model"],
        len(user),
    )
    async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
        resp = await client.post(url, headers=headers, json=payload)
    if resp.status_code >= 400:
        raise RuntimeError(f"llm_http_{resp.status_code}: {resp.text[:200]}")
    data = resp.json()
    if not isinstance(data, dict):
        raise RuntimeError("llm_invalid_response")
    return _strip_code_fence(_extract_completion_text(data))


async def generate_workshop_deliverable(skill: Skill, context: dict[str, Any]) -> dict[str, Any]:
    """
    模版类技能：LLM 生成成稿；失败或无上游时结构化兜底。
    返回与 skill.generate 兼容的字典，content 为 Markdown 字符串。
    """
    system, user = _build_llm_prompt(skill, context)
    mode = "fallback"
    body = ""

    try:
        if _resolve_chat_target():
            body = await _call_llm(system, user)
            mode = "llm"
        elif allow_missing_chat_upstream():
            body = _compose_fallback_deliverable(skill, context)
        else:
            raise RuntimeError("chat_upstream_not_configured")
    except Exception as exc:
        logger.warning(
            "[workshop-llm] generation failed skill=%s err=%s fallback=compose",
            skill.name,
            exc,
        )
        body = _compose_fallback_deliverable(skill, context)
        mode = "fallback"

    body = body.strip()
    if not body:
        body = _compose_fallback_deliverable(skill, context)
        mode = "fallback"

    logger.info(
        "[workshop-llm] done skill=%s mode=%s chars=%s",
        skill.name,
        mode,
        len(body),
    )
    return {
        "skill": skill.name,
        "content": body,
        "word_count": len(re.sub(r"\s", "", body)),
        "generation_mode": mode,
    }


async def execute_workshop_skill_generate(skill: Skill, context: dict[str, Any]) -> dict[str, Any]:
    """统一工坊技能执行入口：模版类走 LLM 成稿，其余走原 generate。"""
    if should_generate_llm_deliverable(skill):
        return await generate_workshop_deliverable(skill, context)
    return await asyncio.to_thread(skill.generate, context)
