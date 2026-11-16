"""对话创作 /chat：单技能白名单直连，核验可调用、有效交付与输出质量。

与前端一致：`entrypoint=chat`，`overrides.skills.mode=allowed_list` 且仅一个技能、
`allow_agent_free_choice=false`。此时任务入口在进编排前直接出稿
（`execution_mode=direct_skill_forced`）。

质量看技能包自己的成稿，不打真实模型：`WORKSHOP_LLM_GENERATION=false`。
"""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import app
from backend.services.skill_lifecycle import is_workspace_content_skill

logger = logging.getLogger("tpdx.tests.chat_skill_catalog")

SKILLS_ROOT = Path(__file__).resolve().parents[1] / "skills"
MIN_CHARS = 80
_LEFTOVER_SLOT = re.compile(
    r"\[(?:技术名|具体场景|具体问题|车型名称|技术品牌|我方车型)\]"
)


def workspace_content_skills() -> list[str]:
    if not SKILLS_ROOT.is_dir():
        return []
    names: list[str] = []
    for entry in sorted(SKILLS_ROOT.iterdir(), key=lambda p: p.name):
        if entry.is_dir() and is_workspace_content_skill(entry.name, entry):
            names.append(entry.name)
    return names


SKILL_NAMES = workspace_content_skills()


def _sample_for_schema(spec: str, probe: str):
    text = spec.lower()
    if "array of string" in text or "array of str" in text:
        return [probe]
    if "array" in text:
        return [
            {
                "name": probe,
                "scene_data": f"{probe} 夜间高速跟车",
                "highlight": probe,
                "scene": probe,
                "benefit": "可感知的安全余量",
                "desc": probe,
            }
        ]
    if "object" in text:
        return {
            "safety": probe,
            "intelligent": probe,
            "quality": probe,
            "space": probe,
            "computing": probe,
            "algorithm": probe,
            "data": probe,
            "ecosystem": probe,
        }
    return probe


def _stamp(value, probe: str):
    if isinstance(value, str):
        return value if probe in value else f"{value} {probe}".strip()
    if isinstance(value, list):
        stamped = [_stamp(item, probe) for item in value]
        return stamped or [probe]
    if isinstance(value, dict):
        stamped = {key: _stamp(item, probe) for key, item in value.items()}
        return stamped or {"note": probe}
    return value


def chat_user_payload(skill_name: str) -> dict:
    """对话里用户会说的那一句，加上技能 schema / 示例输入，供直连技能消费。"""
    skill_dir = SKILLS_ROOT / skill_name
    meta = json.loads((skill_dir / "skill.json").read_text(encoding="utf-8"))
    display = str(meta.get("name") or skill_name)
    triggers = meta.get("triggers") or []
    trigger = str(triggers[0]) if triggers else display
    probe = f"对话探针{skill_name}"

    example_path = skill_dir / "assets" / "input.example.json"
    context: dict = {}
    if example_path.is_file():
        loaded = json.loads(example_path.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            context.update(loaded)

    schema = meta.get("input_schema")
    if isinstance(schema, dict):
        for key, spec in schema.items():
            current = context.get(key)
            if current in (None, "", [], {}):
                context[key] = _sample_for_schema(str(spec), probe)

    init_py = skill_dir / "__init__.py"
    if init_py.is_file():
        source = init_py.read_text(encoding="utf-8")
        for key in re.findall(
            r"""(?:context|ctx)\.get\(\s*["']([A-Za-z0-9_]+)["']\s*,\s*["']""",
            source,
        ):
            if context.get(key) in (None, "", [], {}):
                context[key] = probe

    context = _stamp(context, probe)
    excerpt = (
        f"{probe}\n"
        "高速夜间自动跟车时，前车急刹后本车需要可讲解的制动与提示策略。"
        "这段说明用于对话创作后的知识沉淀，请保留技术边界，不要写成未验证承诺。"
    )
    context["conversation_excerpt"] = excerpt
    context["user_message"] = f"请按「{trigger}」写一版{display}，主题是{probe}。"
    for key in ("tech_name", "theme", "title", "vehicle_model", "project_name", "my_product", "tech_brand"):
        current = context.get(key)
        if not isinstance(current, str) or probe not in current:
            context[key] = probe
    return context


def quality_problems(content: str, probe: str) -> list[str]:
    text = (content or "").strip()
    problems: list[str] = []
    if len(text) < MIN_CHARS:
        problems.append(f"正文过短（{len(text)}<{MIN_CHARS}）")
    if probe not in text:
        problems.append("正文没有回写输入探针，技能未消费对话材料")
    if "Invalid input" in text or "conversation_excerpt 不能为空" in text:
        problems.append("输入未被接受")
    if not (
        text.startswith("#")
        or text.startswith("{")
        or "\n#" in text
        or "##" in text
    ):
        problems.append("缺少 Markdown 标题或结构化正文")
    leftovers = sorted(set(_LEFTOVER_SLOT.findall(text)))
    if leftovers:
        problems.append("模板占位未替换: " + "、".join(leftovers))
    return problems


@pytest.fixture(scope="module")
def chat_client():
    os.environ["WORKSHOP_LLM_GENERATION"] = "false"
    with TestClient(app) as client:
        logger.info("chat_skill_catalog skills=%s", len(SKILL_NAMES))
        yield client


def test_chat_catalog_covers_workspace_skills():
    assert len(SKILL_NAMES) >= 20, SKILL_NAMES


@pytest.mark.parametrize("skill_name", SKILL_NAMES)
def test_chat_skill_callable_effective_and_quality(skill_name: str, chat_client):
    client = chat_client
    payload = chat_user_payload(skill_name)
    probe = f"对话探针{skill_name}"
    response = client.post(
        "/api/v1/tasks/execute",
        headers={"X-User-ID": "default"},
        json={
            "entrypoint": "chat",
            "scenario_id": "general",
            "user_message": json.dumps(payload, ensure_ascii=False),
            "stream": False,
            "overrides": {
                "skills": {
                    "mode": "allowed_list",
                    "allowed": [skill_name],
                    "allow_agent_free_choice": False,
                }
            },
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body.get("code") != 1003, body.get("message")
    content = str(body.get("content") or "")
    logger.info(
        "chat_skill_probe skill=%s mode=%s delivery=%s chars=%s validation_ok=%s",
        skill_name,
        body.get("execution_mode"),
        body.get("delivery_status"),
        len(content),
        (body.get("validation") or {}).get("ok"),
    )

    assert body.get("execution_mode") == "direct_skill_forced"
    assert body.get("used_skills") == [skill_name]
    assert body.get("tool_capture_hit") is False
    assert body.get("delivery_status") == "succeeded", body.get("fallback_reason")
    assert not body.get("fallback_reason")
    validation = body.get("validation") or {}
    assert validation.get("ok") is True, validation

    problems = quality_problems(content, probe)
    assert not problems, f"{skill_name}: " + "；".join(problems) + "\n" + content[:500]
