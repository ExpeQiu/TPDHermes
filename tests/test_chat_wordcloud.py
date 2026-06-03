"""词云统计：中文业务热词过滤与噪音剔除。"""
from backend.services.chat_wordcloud_service import (
    _is_low_quality_message,
    _prepare_message_text,
    aggregate_word_terms,
)


def test_skip_preview_and_json_messages():
    assert _is_low_quality_message("（编排预览）")
    assert _is_low_quality_message('{"skill": "powerpoint", "title": "demo"}')


def test_strip_code_and_keep_chinese_question():
    raw = "请分析吉利技术趋势\n```python\nslide = prs.slides.add_slide()\n```"
    prepared = _prepare_message_text(raw)
    assert "吉利" in prepared
    assert "slide" not in prepared
    assert "prs" not in prepared


def test_aggregate_prefers_chinese_business_terms():
    msgs = [
        "帮我写一份关于吉利新能源技术的简要方案",
        "请分析吉利技术趋势与品牌传播策略",
        "```python\nfrom pptx.util import Inches\nslide.shapes.title.text = 'x'\n```",
        "（编排预览）",
    ]
    result = aggregate_word_terms(msgs, top=10)
    texts = {row["text"] for row in result["terms"]}
    assert "吉利" in texts or "技术" in texts
    assert "slide" not in texts
    assert "prs" not in texts
    assert "Inches" not in texts
    assert result["segmentation_mode"].endswith("_zh")
    assert result["skipped_low_quality_count"] >= 1
    if result["terms"]:
        assert result["terms"][0].get("sample")


def test_english_only_message_skipped():
    assert _is_low_quality_message(
        "slide add color font prs fill shape BLUE textbox ACCENT WHITE True"
    )
