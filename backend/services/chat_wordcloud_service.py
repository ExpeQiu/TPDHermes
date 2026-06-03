"""新对话首条消息词频（冷路径统计，仅 ops 查询时计算）。"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from collections import Counter
from typing import Any

from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.orchestration_run import OrchestrationRun

logger = logging.getLogger("tpdx.hermes.chat_wordcloud")

TOP_TERMS_DEFAULT = 30
MAX_RUNS_SCAN = 5000
MIN_TERM_LEN = 2
MIN_CHINESE_IN_MESSAGE = 2
MIN_CHINESE_RATIO = 0.12
SAMPLE_SNIPPET_WIDTH = 56

_STOPWORDS = frozenset(
    """
    的 了 是 在 我 你 他 她 它 我们 你们 他们 这 那 这个 那个 一个 一些
    请 帮 帮忙 一下 怎么 如何 什么 哪些 可以 能否 是否 还有 以及 或者 而且
    吗 呢 吧 啊 呀 哦 嗯 与 及 和 或 但 而 被 把 对 从 到 为 以 于 也 都 就
    还 很 更 最 非常 比较 关于 进行 使用 需要 想要 希望 如果 因为 所以 然后
    现在 已经 可能 应该 通过 根据 相关 信息 内容 问题 回答 告诉 介绍 说明 分析
    总结 生成 写 做 给 让 把 向 上 下 中 内 外 前 后 里 个 种 次 条 篇 段
    the a an is are was were be been being to of in for on with at by from as and or
    but not no yes please help me my your this that what how can could would should
    """.split()
)

_SKIP_EXACT = frozenset(
    {
        "hello",
        "hi",
        "test",
        "测试",
        "测试消息",
        "新对话",
        "对话创作",
        "（编排预览）",
    }
)

# Skill / 代码 / 模板字段名等（即使用户粘贴也不计入业务热词）
_ENGLISH_TECH_STOP = frozenset(
    """
    slide slides add color font prs fill left shape blue white accent size line text
    textbox title bar inch inches pt true false none null json python import from
    def class return self args kwargs str int float bool dict list optional field
    template context skill skills output input extra source material collection
    workshop orchestration markdown html css http https api mcp hermes agent
    """.split()
)

_BLOCK_LINE_PREFIXES = (
    "[TPDHermes",
    "[项目上下文]",
    "[附件上下文]",
    "[局部改写约束]",
    "[编排",
)

_FENCE_CODE_RE = re.compile(r"```[\w.-]*\s*[\s\S]*?```", re.MULTILINE)
_INLINE_CODE_RE = re.compile(r"`[^`\n]+`")
_ORCHESTRATION_BLOCK_RE = re.compile(
    r"<<<ORCHESTRATION_JSON_BEGIN>>>[\s\S]*?<<<ORCHESTRATION_JSON_END>>>",
    re.MULTILINE,
)
_URL_RE = re.compile(r"https?://\S+")
_WHITESPACE_RE = re.compile(r"[\s\r\n\t]+")
_HAS_CHINESE_RE = re.compile(r"[\u4e00-\u9fff]")

_jieba_ready: bool | None = None


def _loads(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def _is_first_turn_request(request_json: str | None) -> bool:
    req = _loads(request_json)
    msgs = req.get("messages")
    if isinstance(msgs, list) and msgs:
        return False
    return bool((req.get("user_message") or "").strip())


def _chat_mode(request_json: str | None) -> str:
    req = _loads(request_json)
    mode = (req.get("chat_mode") or "co_create").strip()
    return mode or "co_create"


def _first_user_message(request_json: str | None) -> str:
    req = _loads(request_json)
    return (req.get("user_message") or "").strip()


def _chinese_char_count(text: str) -> int:
    return sum(1 for c in text if "\u4e00" <= c <= "\u9fff")


def _strip_bracket_context_blocks(text: str) -> str:
    lines: list[str] = []
    skipping = False
    for line in text.splitlines():
        stripped = line.strip()
        if any(stripped.startswith(prefix) for prefix in _BLOCK_LINE_PREFIXES):
            skipping = True
            continue
        if skipping:
            if not stripped:
                skipping = False
            continue
        lines.append(line)
    return "\n".join(lines)


def _strip_noise_blocks(text: str) -> str:
    cleaned = _ORCHESTRATION_BLOCK_RE.sub(" ", text)
    cleaned = _FENCE_CODE_RE.sub(" ", cleaned)
    cleaned = _INLINE_CODE_RE.sub(" ", cleaned)
    cleaned = _strip_bracket_context_blocks(cleaned)
    return cleaned


def _normalize_text(text: str) -> str:
    cleaned = _URL_RE.sub(" ", text)
    cleaned = _WHITESPACE_RE.sub(" ", cleaned)
    return cleaned.strip()


def _prepare_message_text(raw: str) -> str:
    return _normalize_text(_strip_noise_blocks(raw))


def _is_whole_json_object(text: str) -> bool:
    t = text.strip()
    if not (t.startswith("{") and t.endswith("}")):
        return False
    try:
        return isinstance(json.loads(t), dict)
    except json.JSONDecodeError:
        return False


def _is_low_quality_message(raw: str) -> bool:
    stripped = raw.strip()
    if not stripped or stripped in _SKIP_EXACT:
        return True
    if _is_whole_json_object(stripped):
        return True
    prepared = _prepare_message_text(stripped)
    if not prepared:
        return True
    zh = _chinese_char_count(prepared)
    if zh < MIN_CHINESE_IN_MESSAGE:
        return True
    if len(prepared) > 80 and zh / len(prepared) < MIN_CHINESE_RATIO:
        return True
    return False


def _jieba_available() -> bool:
    global _jieba_ready
    if _jieba_ready is not None:
        return _jieba_ready
    try:
        import jieba  # noqa: F401

        _jieba_ready = True
    except ImportError:
        _jieba_ready = False
        logger.info("chat_wordcloud jieba unavailable, using fallback tokenizer")
    return _jieba_ready


def _tokenize_jieba(text: str) -> list[str]:
    import jieba

    return [t.strip() for t in jieba.cut(text, cut_all=False) if t.strip()]


def _tokenize_fallback(text: str) -> list[str]:
    """仅提取中文片段，不再主动抽取英文单词。"""
    tokens: list[str] = []
    for chunk in re.findall(r"[\u4e00-\u9fff]{2,}", text):
        if len(chunk) <= 4:
            tokens.append(chunk)
        else:
            for i in range(len(chunk) - 1):
                tokens.append(chunk[i : i + 2])
    return tokens


def _accept_token(token: str) -> bool:
    t = token.strip()
    if len(t) < MIN_TERM_LEN:
        return False
    if not _HAS_CHINESE_RE.search(t):
        return False
    lower = t.lower()
    if lower in _STOPWORDS or lower in _SKIP_EXACT:
        return False
    if re.fullmatch(r"[\d.]+", t):
        return False
    if re.fullmatch(r"[^\u4e00-\u9fffA-Za-z0-9]+", t):
        return False
    # 纯英文碎片（jieba 偶发切出）丢弃
    if re.fullmatch(r"[A-Za-z]+", t) and lower in _ENGLISH_TECH_STOP:
        return False
    if re.fullmatch(r"[A-Za-z]+", t):
        return False
    return True


def _snippet_around(text: str, token: str, *, width: int = SAMPLE_SNIPPET_WIDTH) -> str:
    idx = text.find(token)
    if idx < 0:
        snippet = text[:width]
    else:
        start = max(0, idx - width // 3)
        end = min(len(text), start + width)
        snippet = text[start:end]
        if start > 0:
            snippet = "…" + snippet
        if end < len(text):
            snippet = snippet + "…"
    return snippet.replace("\n", " ").strip()


def aggregate_word_terms(
    messages: list[str],
    *,
    top: int = TOP_TERMS_DEFAULT,
) -> dict[str, Any]:
    counter: Counter[str] = Counter()
    samples: dict[str, str] = {}
    base_mode = "jieba" if _jieba_available() else "fallback"
    tokenizer = _tokenize_jieba if base_mode == "jieba" else _tokenize_fallback
    skipped = 0

    for raw in messages:
        if _is_low_quality_message(raw):
            skipped += 1
            continue
        prepared = _prepare_message_text(raw)
        for token in tokenizer(prepared):
            if _accept_token(token):
                counter[token] += 1
                if token not in samples:
                    samples[token] = _snippet_around(prepared, token)

    top_n = min(max(top, 1), 100)
    items = counter.most_common(top_n)
    max_count = items[0][1] if items else 0

    return {
        "segmentation_mode": f"{base_mode}_zh",
        "terms": [
            {
                "text": word,
                "count": count,
                "weight": round(count / max_count, 4) if max_count else 0.0,
                "sample": samples.get(word, ""),
            }
            for word, count in items
        ],
        "skipped_low_quality_count": skipped,
    }


async def build_chat_wordcloud(
    db: AsyncSession,
    *,
    since: str,
    top: int = TOP_TERMS_DEFAULT,
) -> dict[str, Any]:
    rows = (
        await db.execute(
            select(OrchestrationRun.request_json)
            .where(
                OrchestrationRun.entrypoint == "chat",
                OrchestrationRun.created_at >= since,
            )
            .order_by(desc(OrchestrationRun.created_at))
            .limit(MAX_RUNS_SCAN)
        )
    ).all()

    messages: list[str] = []
    for (request_json,) in rows:
        if not _is_first_turn_request(request_json):
            continue
        if _chat_mode(request_json) != "co_create":
            continue
        msg = _first_user_message(request_json)
        if msg:
            messages.append(msg)

    result = await asyncio.to_thread(aggregate_word_terms, messages, top=top)
    result["new_conversation_count"] = len(messages)
    result["scanned_run_count"] = len(rows)

    logger.info(
        "chat_wordcloud since=%s scanned=%s new_conversations=%s terms=%s "
        "skipped_low_quality=%s mode=%s",
        since,
        len(rows),
        len(messages),
        len(result.get("terms") or []),
        result.get("skipped_low_quality_count"),
        result.get("segmentation_mode"),
    )
    return result
