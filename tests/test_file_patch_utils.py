"""file_patch_utils 单元测试。"""

import pytest

from backend.services.file_action_service import (
    normalize_create_file_path,
    normalize_output_title,
    parse_file_actions_from_content,
)
from backend.services.file_patch_utils import (
    apply_line_range_replace,
    apply_search_replace,
    resolve_patch_content,
)


def test_apply_search_replace_unique():
    content = "hello world"
    assert apply_search_replace(content, "world", "TPD") == "hello TPD"


def test_apply_search_replace_not_found():
    with pytest.raises(ValueError, match="未找到"):
        apply_search_replace("abc", "xyz", "1")


def test_apply_search_replace_ambiguous():
    with pytest.raises(ValueError, match="匹配到 2 处"):
        apply_search_replace("aa aa", "aa", "b")


def test_apply_line_range_replace():
    content = "a\nb\nc\nd"
    assert apply_line_range_replace(content, 2, 3, "B\nC") == "a\nB\nC\nd"


def test_resolve_patch_content_search_replace():
    action = {
        "edit_mode": "search_replace",
        "old_string": "旧",
        "new_string": "新",
    }
    assert resolve_patch_content("前文旧后文", action) == "前文新后文"


def test_resolve_patch_content_line_range():
    action = {
        "edit_mode": "line_range",
        "start_line": 2,
        "end_line": 2,
        "new_text": "B2",
    }
    assert resolve_patch_content("A\nB\nC", action) == "A\nB2\nC"


def test_normalize_create_file_path():
    assert normalize_create_file_path("稿.md", "/Users/expeqiu/稿.md") == "/输出/稿.md"
    assert normalize_create_file_path("稿.md", "/输出/稿.md") == "/输出/稿.md"


def test_normalize_output_title():
    assert normalize_output_title("营销推广文案") == "营销推广文案.md"
    assert normalize_output_title("稿.md") == "稿.md"


def test_parse_file_actions_normalizes_path():
    content = """```tphermes_file_actions
{"actions": [{"type": "create", "fileName": "稿.md", "path": "/Users/x/稿.md", "content": "# hi"}]}
```"""
    actions = parse_file_actions_from_content(content)
    assert actions[0]["path"] == "/输出/稿.md"


def test_parse_file_actions_partial_patch_fields():
    content = """```tphermes_file_actions
{"actions": [{
  "type": "patch",
  "proposalId": "p2",
  "fileId": "f1",
  "editMode": "search_replace",
  "oldString": "旧",
  "newString": "新",
  "summary": "局部改"
}]}
```"""
    actions = parse_file_actions_from_content(content)
    assert len(actions) == 1
    row = actions[0]
    assert row["edit_mode"] == "search_replace"
    assert row["old_string"] == "旧"
    assert row["new_string"] == "新"
    assert row["after"] == "新"
