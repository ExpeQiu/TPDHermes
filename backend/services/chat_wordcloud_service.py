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

_NOISE_EXACT = frozenset(
    {
        "hello",
        "hi",
        "test",
        "测试",
        "测试消息",
        "新对话",
        "对话创作",
    }
)

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


def _normalize_text(text: str) -> str:
    cleaned = re.sub(r"https?://\S+", " ", text)
    cleaned = re.sub(r"[\s\r\n\t]+", " ", cleaned)
    return cleaned.strip()


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
    tokens: list[str] = []
    for chunk in re.findall(r"[A-Za-z]{3,}|[\u4e00-\u9fff]{2,}", text):
        if re.fullmatch(r"[A-Za-z]+", chunk):
            tokens.append(chunk.lower())
        else:
            if len(chunk) <= 4:
                tokens.append(chunk)
            else:
                for i in range(len(chunk) - 1):
                    tokens.append(chunk[i : i + 2])
    return tokens


def _accept_token(token: str) -> bool:
    t = token.strip().lower()
    if len(t) < MIN_TERM_LEN:
        return False
    if t in _STOPWORDS or t in _NOISE_EXACT:
        return False
    if re.fullmatch(r"\d+", t):
        return False
    if re.fullmatch(r"[^\u4e00-\u9fffA-Za-z0-9]+", t):
        return False
    return True


def aggregate_word_terms(
    messages: list[str],
    *,
    top: int = TOP_TERMS_DEFAULT,
) -> dict[str, Any]:
    counter: Counter[str] = Counter()
    tokenizer = _tokenize_jieba if _jieba_available() else _tokenize_fallback
    mode = "jieba" if _jieba_available() else "fallback"

    for raw in messages:
        text = _normalize_text(raw)
        if not text or text in _NOISE_EXACT:
            continue
        for token in tokenizer(text):
            if _accept_token(token):
                counter[token] += 1

    top_n = min(max(top, 1), 100)
    items = counter.most_common(top_n)
    max_count = items[0][1] if items else 0

    return {
        "segmentation_mode": mode,
        "terms": [
            {
                "text": word,
                "count": count,
                "weight": round(count / max_count, 4) if max_count else 0.0,
            }
            for word, count in items
        ],
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
        "chat_wordcloud since=%s scanned=%s new_conversations=%s terms=%s mode=%s",
        since,
        len(rows),
        len(messages),
        len(result.get("terms") or []),
        result.get("segmentation_mode"),
    )
    return result
