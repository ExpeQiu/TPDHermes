"""共创房间的写入合同与引用装载。服务端解析，不信任客户端扩展字段。"""

from __future__ import annotations

import logging
import os
import re
from typing import Any

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.output_asset import OutputAsset
from backend.models.project_attachment import ProjectAttachment
from backend.services.project_files_service import (
    REFERENCED_ATTACHMENT_MAX_CHARS,
    REFERENCED_OUTPUT_MAX_CHARS,
    REFERENCED_TOTAL_MAX_CHARS,
    get_project_file_detail,
)

logger = logging.getLogger("tpdx.hermes.co_create_room")

_DENY_WRITE_RE = re.compile(r"不要(生成|写|落稿|输出|创建|修订)|别写|不要生成文档|不要写文档")
_DELIVERABLE = r"文稿|文档|稿件|方案|报告|纪要|提纲|正式稿"
_CREATE_RE = re.compile(
    rf"(?:整理|梳理|汇总|转成|转为|写成|起草|拟定|产出|落成)(?:成|为|出)?(?:一[份个])?(?:{_DELIVERABLE})"
    rf"|(?:写|做|出|生成)(?:一[份个版稿]|个)?(?:{_DELIVERABLE})"
    r"|写一版|写一稿|出一版|出稿|成稿"
    r"|存档(?:以上|这段|这份)?(?:文稿|文档)?"
    r"|归档(?:以上|这段|这份)?(?:文稿|文档)?"
    r"|保存到项目文件|存到项目文件|落入项目文件"
)
_DISK_NOTICE_RE = re.compile(r"未落库|被标记为禁止|/opt/data/输出|tphermes_file_actions")
_STRONG_CREATE_RE = re.compile(r"整理成|转成|转为|写成|写一版|写一稿|出一版|起草|落成|成稿")
_REVISE_RE = re.compile(r"修订|改写|删除原句|补一节|更新文稿|更新文档|改一版|再写一版|重写|改一下|润色|参与修改")
_QUESTION_RE = re.compile(r"[?？]|什么|怎么|为什么|哪些|是否|吗")
_META_PREAMBLE_RE = re.compile(r"落盘|被标记为禁止|仅本地|已整理成稿|write_file")
_PLAN_CONFIRM_RE = re.compile(
    r"^(确认(执行|计划)?|开始执行|按计划执行|执行计划|继续执行|ok|go|yes)$",
    re.I,
)

READ_ONLY_REASON = {"ask", "plan_draft", "denied", "no_plan", "stale_plan", "unclear", "archived"}


def writer_driver_name() -> str:
    return os.getenv("ROOM_WRITER_DRIVER", "hermes").strip().lower() or "hermes"


def is_plan_confirm(text: str) -> bool:
    return bool(_PLAN_CONFIRM_RE.match((text or "").strip()))


def denies_write(text: str) -> bool:
    return bool(_DENY_WRITE_RE.search(text or ""))


def classify_document_intent(text: str) -> str:
    """成稿策略：deny 不写；create 新建；revise 覆盖当前文稿；chat 只回答。"""
    raw = (text or "").strip()
    if not raw:
        return "chat"
    if denies_write(raw):
        return "deny"
    if _QUESTION_RE.search(raw) and not _STRONG_CREATE_RE.search(raw):
        return "chat"
    if _REVISE_RE.search(raw):
        return "revise"
    if _CREATE_RE.search(raw):
        return "create"
    return "chat"


def explicit_write_intent(text: str) -> bool:
    return classify_document_intent(text) in {"create", "revise"}


def manuscript_for_file(reply: str) -> str:
    """落盘时丢掉「已写入某路径」这类说明，从标题开始保存。"""
    text = (reply or "").strip()
    if not text:
        return ""
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if not line.lstrip().startswith("#"):
            continue
        preamble = "\n".join(lines[:index])
        if index == 0 or _META_PREAMBLE_RE.search(preamble):
            return "\n".join(lines[index:]).strip()
        return text
    return text


def _yaml_file_action(reply: str) -> dict[str, Any] | None:
    """Hermes 常把动作写成缩进文本，而不是 JSON。"""
    match = re.search(r"```tphermes_file_actions\s*\n(.*?)```", reply or "", re.S)
    if not match:
        return None
    action_type = "create"
    path = ""
    content_lines: list[str] = []
    in_content = False
    for line in match.group(1).splitlines():
        stripped = line.strip()
        if not in_content and re.match(r"-?\s*action\s*:", stripped):
            action_type = stripped.split(":", 1)[1].strip() or "create"
            continue
        if not in_content and re.match(r"-?\s*path\s*:", stripped):
            path = stripped.split(":", 1)[1].strip()
            continue
        if re.match(r"\s*-?\s*content\s*:\s*\|", line):
            in_content = True
            continue
        if in_content:
            content_lines.append(line)
    body = "\n".join(content_lines)
    indents = [len(line) - len(line.lstrip(" ")) for line in body.splitlines() if line.strip()]
    if indents:
        cut = min(indents)
        body = "\n".join(line[cut:] if line.startswith(" " * cut) else line for line in body.splitlines())
    body = body.strip()
    if action_type not in {"create", "patch"} or not body:
        return None
    name = (path.rsplit("/", 1)[-1] if path else "").strip() or "共创文稿.md"
    return {
        "type": action_type,
        "file_name": name,
        "path": path or f"/输出/{name}",
        "content": body,
    }


def authorized_hermes_action(reply: str) -> dict[str, Any] | None:
    """Agent 模式下，带正文的 create/patch 提案由平台执行。"""
    from backend.services.file_action_service import parse_file_actions_from_content

    for action in parse_file_actions_from_content(reply or ""):
        body = str(action.get("content") or action.get("after") or "").strip()
        if str(action.get("type") or "") in {"create", "patch"} and body:
            action = dict(action)
            action["content"] = body
            return action
    return _yaml_file_action(reply)


def project_file_body(reply: str, prior: list[str] | None = None) -> str:
    """磁盘存档说明不是项目文件。正文过短时，改存此前对话里的文稿。"""
    cleaned = manuscript_for_file(reply)
    notice = bool(_DISK_NOTICE_RE.search(reply or ""))
    if cleaned and not (notice and len(cleaned) < 800):
        return cleaned
    best = ""
    for item in prior or []:
        body = item.split(":", 1)[-1].strip()
        if not body or _DISK_NOTICE_RE.search(body):
            continue
        extracted = manuscript_for_file(body)
        if len(extracted) > len(best):
            best = extracted
    return best or cleaned


def document_file_stem(body: str, fallback: str) -> str:
    title = ""
    for line in (body or "").splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            title = stripped[2:].strip()
            break
    title = title or (fallback or "").strip() or "共创文稿"
    title = re.sub(r"[\\/:*?\"<>|\r\n]+", " ", title)
    title = re.sub(r"\s+", " ", title).strip(" .")
    return (title[:40] or "共创文稿")


def allows_file_write(
    *,
    mode: str,
    text: str,
    has_plan: bool,
    plan_version: int,
    confirm_plan_version: int | None,
    archived: bool,
) -> tuple[bool, str]:
    """Ask、未确认 Plan、否定写入、过期确认都不能落稿。"""
    if archived:
        return False, "archived"
    if denies_write(text):
        return False, "denied"
    resolved = (mode or "agent").strip().lower()
    if resolved == "ask":
        return False, "ask"
    if is_plan_confirm(text):
        if not has_plan or plan_version <= 0:
            return False, "no_plan"
        if confirm_plan_version is not None and int(confirm_plan_version) != int(plan_version):
            return False, "stale_plan"
        return True, "plan_confirmed"
    if resolved == "plan":
        return False, "plan_draft"
    if resolved == "agent":
        intent = classify_document_intent(text)
        if intent in {"create", "revise"}:
            return True, intent
    return False, "unclear"


def delivery_document(title: str, delivery: str) -> str:
    body = (delivery or "").strip()
    if not body:
        raise ValueError("主笔没有交付正文")
    if body.startswith("#"):
        return body if body.endswith("\n") else body + "\n"
    return f"# {title}\n\n{body}\n"


def _trim(text: str, limit: int) -> tuple[str, bool]:
    raw = (text or "").strip()
    if len(raw) <= limit:
        return raw, False
    return raw[:limit] + "\n…（已截断）", True


async def _output_in_other_project(db: AsyncSession, file_id: str, project_id: str) -> bool:
    row = await db.get(OutputAsset, file_id)
    return bool(row and row.project_id != project_id)


async def _attachment_in_other_project(db: AsyncSession, file_id: str, project_id: str) -> bool:
    row = await db.get(ProjectAttachment, file_id)
    return bool(row and row.project_id != project_id)


async def resolve_room_files(
    db: AsyncSession,
    *,
    project_id: str,
    files: list[dict[str, Any]] | None,
    mention_file_ids: list[str] | None,
) -> list[dict[str, Any]]:
    """校验归属后装载正文。无权文件不返回标题。跨项目在共享规则确定前拒绝。"""
    refs: list[dict[str, Any]] = []
    for item in files or []:
        if not isinstance(item, dict):
            continue
        refs.append(
            {
                "project_id": str(item.get("project_id") or project_id),
                "file_id": str(item.get("file_id") or "").strip(),
                "kind": str(item.get("kind") or "output").strip() or "output",
                "version": str(item.get("version") or "").strip(),
                "purpose": str(item.get("purpose") or "material").strip() or "material",
            }
        )
    for file_id in mention_file_ids or []:
        cleaned = str(file_id).strip()
        if not cleaned:
            continue
        if any(ref["file_id"] == cleaned for ref in refs):
            continue
        refs.append(
            {
                "project_id": project_id,
                "file_id": cleaned,
                "kind": "output",
                "version": "",
                "purpose": "material",
            }
        )

    resolved: list[dict[str, Any]] = []
    total = 0
    for ref in refs:
        if not ref["file_id"]:
            raise HTTPException(status_code=400, detail="文件引用缺少 file_id")
        if ref["project_id"] != project_id:
            logger.info(
                "[co-create-room] cross project file refused room_project=%s file_project=%s file_id=%s",
                project_id,
                ref["project_id"],
                ref["file_id"],
            )
            raise HTTPException(status_code=403, detail="跨项目材料未授权，不能进入共享群聊")
        kind = ref["kind"]
        if kind not in {"output", "attachment"}:
            raise HTTPException(status_code=400, detail="不支持的文件类型")
        foreign = (
            await _output_in_other_project(db, ref["file_id"], project_id)
            if kind == "output"
            else await _attachment_in_other_project(db, ref["file_id"], project_id)
        )
        if foreign:
            logger.info(
                "[co-create-room] foreign file hidden project_id=%s file_id=%s kind=%s",
                project_id,
                ref["file_id"],
                kind,
            )
            raise HTTPException(status_code=404, detail="无权访问该文件")
        detail = await get_project_file_detail(db, project_id, ref["file_id"], kind)
        if not detail:
            if kind == "output":
                detail = await get_project_file_detail(db, project_id, ref["file_id"], "attachment")
                kind = "attachment" if detail else kind
            elif kind == "attachment":
                detail = await get_project_file_detail(db, project_id, ref["file_id"], "output")
                kind = "output" if detail else kind
        if not detail:
            raise HTTPException(status_code=404, detail="无权访问该文件")
        limit = REFERENCED_OUTPUT_MAX_CHARS if kind == "output" else REFERENCED_ATTACHMENT_MAX_CHARS
        excerpt, truncated = _trim(str(detail.get("content") or ""), limit)
        remain = REFERENCED_TOTAL_MAX_CHARS - total
        if remain <= 0:
            truncated = True
            excerpt = ""
        elif len(excerpt) > remain:
            excerpt = excerpt[:remain] + "\n…（已截断）"
            truncated = True
        total += len(excerpt)
        version = str(detail.get("version") or ref["version"] or "")
        resolved.append(
            {
                "project_id": project_id,
                "file_id": ref["file_id"],
                "kind": kind,
                "version": version,
                "purpose": ref["purpose"],
                "title": str(detail.get("title") or ""),
                "excerpt": excerpt,
                "truncated": truncated,
            }
        )
        logger.info(
            "[co-create-room] file resolved project_id=%s file_id=%s kind=%s purpose=%s chars=%s truncated=%s",
            project_id,
            ref["file_id"],
            kind,
            ref["purpose"],
            len(excerpt),
            truncated,
        )
    return resolved
