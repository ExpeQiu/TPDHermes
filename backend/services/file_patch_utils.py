"""OutputAsset 局部 patch 工具（search_replace / line_range）。"""

from __future__ import annotations


def apply_search_replace(
    content: str,
    old_string: str,
    new_string: str,
    *,
    replace_all: bool = False,
) -> str:
    if not old_string:
        raise ValueError("old_string 不能为空")
    if old_string not in content:
        raise ValueError("old_string 在文件中未找到，请核对原文是否一致")
    if replace_all:
        return content.replace(old_string, new_string)
    count = content.count(old_string)
    if count > 1:
        raise ValueError(f"old_string 匹配到 {count} 处，须唯一匹配或设置 replace_all=true")
    return content.replace(old_string, new_string, 1)


def apply_line_range_replace(
    content: str,
    start_line: int,
    end_line: int,
    new_text: str,
) -> str:
    if start_line < 1 or end_line < start_line:
        raise ValueError("行号范围无效")
    lines = content.split("\n")
    if end_line > len(lines):
        raise ValueError(f"end_line={end_line} 超出文件行数 {len(lines)}")
    replacement = new_text.split("\n") if new_text else []
    updated = lines[: start_line - 1] + replacement + lines[end_line:]
    return "\n".join(updated)


def resolve_patch_content(previous_content: str, action: dict) -> str:
    """根据 edit_mode 从原文解析出 patch 后的全文。"""
    edit_mode = str(action.get("edit_mode") or action.get("editMode") or "full").strip()
    if edit_mode == "search_replace":
        old_string = str(action.get("old_string") or action.get("oldString") or "")
        new_string = str(action.get("new_string") or action.get("newString") or "")
        replace_all = bool(action.get("replace_all") or action.get("replaceAll"))
        return apply_search_replace(
            previous_content,
            old_string,
            new_string,
            replace_all=replace_all,
        )
    if edit_mode == "line_range":
        start_line = int(action.get("start_line") or action.get("startLine") or 0)
        end_line = int(action.get("end_line") or action.get("endLine") or 0)
        new_text = str(
            action.get("new_text")
            or action.get("newText")
            or action.get("after")
            or action.get("content")
            or "",
        )
        return apply_line_range_replace(previous_content, start_line, end_line, new_text)

    content = str(action.get("content") or action.get("after") or "").strip()
    if not content:
        raise ValueError("修改内容不能为空")
    return content


def normalize_patch_action_fields(item: dict) -> dict:
    """从 Agent JSON 块归一化 patch 字段。"""
    edit_mode = str(item.get("editMode") or item.get("edit_mode") or "full").strip()
    if edit_mode not in ("full", "search_replace", "line_range"):
        edit_mode = "full"
    out: dict = {
        "edit_mode": edit_mode,
        "old_string": str(item.get("oldString") or item.get("old_string") or ""),
        "new_string": str(item.get("newString") or item.get("new_string") or ""),
        "replace_all": bool(item.get("replaceAll") or item.get("replace_all")),
        "start_line": item.get("startLine") or item.get("start_line"),
        "end_line": item.get("endLine") or item.get("end_line"),
        "new_text": str(item.get("newText") or item.get("new_text") or ""),
    }
    return out
