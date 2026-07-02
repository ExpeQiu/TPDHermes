"""工坊 LLM 成稿生成。"""

import pytest

from backend.services.skill_loader import Skill
from backend.services.workshop_execution import extract_text_from_tool_payload
from backend.services.workshop_llm_generator import (
    _compose_fallback_deliverable,
    generate_workshop_deliverable,
    should_generate_llm_deliverable,
    workshop_llm_generation_enabled,
)


class _TemplateSkillStub(Skill):
    template_content = "# 模版标题\n\n[占位符]"

    @property
    def name(self) -> str:
        return "stub_template_skill"

    def generate(self, context):
        return {"skill": self.name, "content": "# 模版标题\n\n不应落库"}

    def validate_input(self, input_data):
        return True


class _PlainSkillStub(Skill):
    @property
    def name(self) -> str:
        return "stub_plain_skill"

    def generate(self, context):
        return {"skill": self.name, "greeting": "Hello"}

    def validate_input(self, input_data):
        return True


@pytest.mark.asyncio
async def test_should_generate_llm_deliverable_for_template_skill():
    assert workshop_llm_generation_enabled()
    assert should_generate_llm_deliverable(_TemplateSkillStub()) is True
    assert should_generate_llm_deliverable(_PlainSkillStub()) is False


@pytest.mark.asyncio
async def test_generate_workshop_deliverable_fallback_not_template(monkeypatch):
    monkeypatch.delenv("HERMES_CHAT_API_URL", raising=False)

    skill = _TemplateSkillStub()
    result = await generate_workshop_deliverable(
        skill,
        {
            "tech_name": "千里浩瀚",
            "scene_pain": "高速障碍物反应不及时",
            "tech_solution": "端到端感知融合方案",
            "user_value": "更安全的高速体验",
            "highlights": [{"name": "AEB", "scene_data": "130km/h 刹停"}],
            "knowledge_results": [
                {"content": "充电桩网络覆盖提升", "metadata": {"title": "充电网络"}},
            ],
        },
    )

    body = result["content"]
    assert "模版标题" not in body
    assert "结构框架" not in body
    assert "占位符" not in body
    assert "千里浩瀚" in body
    assert result["generation_mode"] == "fallback"


def test_extract_text_from_nested_skill_content():
    payload = {
        "success": True,
        "content": {
            "skill": "speech_skill",
            "content": "# 成稿标题\n\n正文段落。",
            "word_count": 10,
        },
        "skill": "speech_skill",
    }
    text = extract_text_from_tool_payload("workshop_generate", payload)
    assert text.startswith("# 成稿标题")
    assert "speech_skill" not in text.splitlines()[0]


def test_compose_fallback_includes_highlights():
    skill = _TemplateSkillStub()
    text = _compose_fallback_deliverable(
        skill,
        {
            "tech_name": "智能充电",
            "highlights": [{"name": "快充", "scene_data": "10分钟补能200km"}],
        },
    )
    assert "智能充电" in text
    assert "快充" in text
