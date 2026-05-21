"""
知识库本地 Embedding（Sentence Transformers）。

Chroma 0.5+ 无服务端 embedding 时，查询须传 query_embeddings；
历史 upsert 仅写入 documents 时，还需对拉取的文档做本地向量重排。
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from functools import lru_cache
from typing import Any, Sequence

logger = logging.getLogger("tpdx.hermes.kb_embed")

_MARKDOWN_IMAGE_RE = re.compile(r"!\[[^\]]*\]\([^)]+\)")
_WHITESPACE_RE = re.compile(r"\s+")


def embed_enabled() -> bool:
    raw = os.getenv("KB_EMBED_ENABLED", "1").strip().lower()
    return raw not in ("0", "false", "no", "off")


def embed_on_upsert_enabled() -> bool:
    raw = os.getenv("KB_EMBED_ON_UPSERT", "1").strip().lower()
    return embed_enabled() and raw not in ("0", "false", "no", "off")


def embed_model_name() -> str:
    return os.getenv("KB_EMBED_MODEL", "BAAI/bge-small-zh-v1.5").strip()


def local_rank_max_docs() -> int:
    try:
        return max(50, min(2000, int(os.getenv("KB_LOCAL_RANK_MAX_DOCS", "500"))))
    except ValueError:
        return 500


def extract_searchable_text(document: str, metadata: dict[str, Any] | None = None) -> str:
    """从 Markdown 正文中提取可用于检索的文本（弱化图片链接噪声）。"""
    meta = metadata or {}
    text = str(document or "")
    text = _MARKDOWN_IMAGE_RE.sub(" ", text)
    text = _WHITESPACE_RE.sub(" ", text).strip()
    title = str(meta.get("title") or meta.get("doc_id") or "").strip()
    if title and title not in text[: min(len(text), 240)]:
        text = f"{title}\n{text}" if text else title
    return text[:4000]


@lru_cache(maxsize=1)
def _load_model():
    from sentence_transformers import SentenceTransformer

    name = embed_model_name()
    logger.info("loading sentence-transformers model=%s", name)
    return SentenceTransformer(name)


def embed_texts_sync(texts: Sequence[str]) -> list[list[float]]:
    """同步编码（ingest / asyncio.to_thread 内调用）。"""
    if not texts:
        return []
    cleaned = [(t or "").strip() or " " for t in texts]
    model = _load_model()
    vectors = model.encode(
        cleaned,
        normalize_embeddings=True,
        show_progress_bar=False,
    )
    return [vec.tolist() for vec in vectors]


async def embed_texts(texts: Sequence[str]) -> list[list[float]]:
    if not embed_enabled():
        return []
    return await asyncio.to_thread(embed_texts_sync, list(texts))


async def embed_query_texts(texts: Sequence[str]) -> list[list[float]]:
    return await embed_texts(texts)


def cosine_scores(query_vec: list[float], doc_vecs: list[list[float]]) -> list[float]:
    if not query_vec or not doc_vecs:
        return []
    scores: list[float] = []
    for dv in doc_vecs:
        if not dv or len(dv) != len(query_vec):
            scores.append(-1.0)
            continue
        scores.append(sum(a * b for a, b in zip(query_vec, dv)))
    return scores
