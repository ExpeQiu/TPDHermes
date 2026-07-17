"""知识库绑定：目录加载 + 检索上下文（供协作模式注入）。"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, Optional

import httpx
import yaml

from multi_agent.utils.errors import MultiAgentError

logger = logging.getLogger("multi_agent.knowledge")

CATALOG_PATH = Path(__file__).resolve().parent / "catalog.yml"


def _load_catalog() -> list[dict[str, Any]]:
    if not CATALOG_PATH.is_file():
        return [{"id": "none", "name": "不绑定", "kind": "none", "description": ""}]
    with CATALOG_PATH.open("r", encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    items = raw.get("items") if isinstance(raw, dict) else None
    if not isinstance(items, list):
        return [{"id": "none", "name": "不绑定", "kind": "none", "description": ""}]
    out: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict) or not item.get("id"):
            continue
        out.append(dict(item))
    if not any(i.get("id") == "none" for i in out):
        out.insert(0, {"id": "none", "name": "不绑定", "kind": "none", "description": ""})
    return out


def list_knowledge_bases() -> list[dict[str, Any]]:
    items = []
    for kb in _load_catalog():
        path = str(kb.get("path") or "").strip()
        path_ok = True if kb["id"] == "none" else (bool(path) and Path(path).expanduser().is_dir())
        api = str(kb.get("api_base") or "").strip()
        items.append(
            {
                "id": kb["id"],
                "name": kb.get("name") or kb["id"],
                "description": kb.get("description") or "",
                "kind": kb.get("kind") or "none",
                "path": path,
                "api_base": api,
                "available": kb["id"] == "none" or path_ok or bool(api),
                "path_ok": path_ok,
            }
        )
    return items


def get_knowledge_base(kb_id: str) -> dict[str, Any]:
    kid = (kb_id or "none").strip() or "none"
    for kb in _load_catalog():
        if kb.get("id") == kid:
            return dict(kb)
    raise MultiAgentError(f"未知知识库: {kid}")


def _format_hits(hits: list[dict[str, Any]], *, kb_id: str) -> str:
    if not hits:
        return ""
    lines = [f"### 知识库检索（{kb_id}）", ""]
    for i, h in enumerate(hits, 1):
        title = h.get("title") or h.get("document_id") or h.get("path") or f"hit-{i}"
        score = h.get("score")
        score_s = f" score={score}" if score is not None else ""
        content = str(h.get("content") or "").strip()
        if len(content) > 600:
            content = content[:600] + "…"
        lines.append(f"{i}. **{title}**{score_s}")
        if content:
            lines.append(f"   {content}")
        lines.append("")
    return "\n".join(lines).strip()


def _search_http(api_base: str, query: str, *, top_k: int) -> list[dict[str, Any]]:
    url = f"{api_base.rstrip('/')}/api/v1/search"
    try:
        with httpx.Client(timeout=8.0) as client:
            resp = client.post(
                url,
                json={"query": query, "top_k": top_k, "include_content": True},
            )
            if resp.status_code >= 400:
                logger.warning("KB HTTP 检索失败 status=%s url=%s", resp.status_code, url)
                return []
            data = resp.json()
    except Exception as exc:  # noqa: BLE001
        logger.warning("KB HTTP 不可达 url=%s err=%s", url, exc)
        return []

    hits = data.get("hits") or data.get("results") or data.get("items") or []
    if not isinstance(hits, list):
        return []
    out: list[dict[str, Any]] = []
    for h in hits[:top_k]:
        if not isinstance(h, dict):
            continue
        out.append(
            {
                "title": h.get("title") or h.get("slug") or h.get("document_id"),
                "content": h.get("content") or h.get("text") or "",
                "score": h.get("score"),
                "document_id": h.get("document_id"),
                "path": h.get("path"),
            }
        )
    logger.info("KB HTTP 命中 n=%s query=%s", len(out), query[:60])
    return out


def _search_wiki_files(root: Path, query: str, *, top_k: int) -> list[dict[str, Any]]:
    wiki = root / "wiki"
    if not wiki.is_dir():
        return []
    terms = [t for t in re.split(r"[\s，。、；;,.!?？]+", query) if len(t) >= 2][:6]
    if not terms:
        terms = [query[:20]]
    scored: list[tuple[float, Path, str]] = []
    for path in wiki.rglob("*.md"):
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        low = text.lower()
        score = 0.0
        for t in terms:
            score += low.count(t.lower()) * (2.0 if len(t) >= 4 else 1.0)
        if score <= 0:
            continue
        # 优先文件名命中
        if any(t.lower() in path.name.lower() for t in terms):
            score += 5.0
        scored.append((score, path, text))
    scored.sort(key=lambda x: x[0], reverse=True)
    out: list[dict[str, Any]] = []
    for score, path, text in scored[:top_k]:
        # 去掉 front matter
        body = text
        if body.startswith("---"):
            end = body.find("\n---", 3)
            if end != -1:
                body = body[end + 4 :]
        snippet = body.strip()
        if len(snippet) > 800:
            # 尝试截到第一个含关键词的段落
            pos = -1
            for t in terms:
                p = snippet.lower().find(t.lower())
                if p >= 0 and (pos < 0 or p < pos):
                    pos = p
            start = max(0, pos - 80) if pos >= 0 else 0
            snippet = snippet[start : start + 800] + "…"
        out.append(
            {
                "title": path.stem,
                "content": snippet,
                "score": round(score, 2),
                "path": str(path.relative_to(root)),
            }
        )
    logger.info("KB 本地 wiki 命中 n=%s root=%s", len(out), root)
    return out


def retrieve_context(
    kb_id: Optional[str],
    query: str,
    *,
    top_k: Optional[int] = None,
) -> str:
    """检索并格式化为可注入 prompt 的 Markdown；无绑定或无命中返回空串。"""
    kid = (kb_id or "none").strip() or "none"
    if kid in {"", "none", "null"}:
        return ""
    kb = get_knowledge_base(kid)
    k = int(top_k or kb.get("top_k") or 5)
    q = (query or "").strip()
    if not q:
        return ""

    hits: list[dict[str, Any]] = []
    api = str(kb.get("api_base") or "").strip()
    if api:
        hits = _search_http(api, q, top_k=k)

    if not hits:
        path = str(kb.get("path") or "").strip()
        root = Path(path).expanduser() if path else None
        if root and root.is_dir():
            hits = _search_wiki_files(root, q, top_k=k)
        else:
            logger.warning("知识库不可用 id=%s path=%s api=%s", kid, path, api)

    return _format_hits(hits, kb_id=kid)
