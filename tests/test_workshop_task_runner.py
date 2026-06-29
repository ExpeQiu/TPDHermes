"""workshop_task_runner 单元测试。"""

from __future__ import annotations

from backend.services.workshop_task_runner import _skill_result_to_text


def test_skill_result_to_text_extracts_content_field() -> None:
    result = {
        "skill": "tech_trend_skill",
        "content": "# 技术方向趋势研判\n\n## 技术现状\n正文",
        "context": {"_raw_user_message": "test"},
    }
    text = _skill_result_to_text(result)
    assert text.startswith("# 技术方向趋势研判")
    assert '"skill"' not in text


def test_skill_result_to_text_prepends_title_when_needed() -> None:
    result = {"skill": "demo", "title": "方案标题", "content": "正文段落"}
    text = _skill_result_to_text(result)
    assert text == "# 方案标题\n\n正文段落"


def test_skill_result_to_text_string_json_envelope() -> None:
    raw = '{"skill":"tech_trend_skill","content":"# 标题\\n正文"}'
    text = _skill_result_to_text(raw)
    assert text.startswith("# 标题")
