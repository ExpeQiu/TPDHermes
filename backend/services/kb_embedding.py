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
from pathlib import Path
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


def _default_embed_cache_dir() -> str:
    # backend/services/kb_embedding.py -> 项目根目录
    root = Path(__file__).resolve().parents[2]
    return str(root / ".cache" / "huggingface")


def embed_cache_dir() -> str:
    return os.getenv("KB_EMBED_CACHE_DIR", _default_embed_cache_dir()).strip()


def _configure_embed_cache_env() -> str:
    cache_root = embed_cache_dir()
    Path(cache_root).mkdir(parents=True, exist_ok=True)
    # 统一 HuggingFace / Transformers / SentenceTransformers 缓存根目录
    os.environ.setdefault("HF_HOME", cache_root)
    os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(Path(cache_root) / "hub"))
    os.environ.setdefault("TRANSFORMERS_CACHE", str(Path(cache_root) / "transformers"))
    os.environ.setdefault("SENTENCE_TRANSFORMERS_HOME", str(Path(cache_root) / "sentence_transformers"))
    return cache_root


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
    cache_root = _configure_embed_cache_env()
    hf_endpoint = os.getenv("HF_ENDPOINT", "").strip()
    if hf_endpoint:
        os.environ.setdefault("HF_ENDPOINT", hf_endpoint)
    logger.info(
        "loading sentence-transformers model=%s cache_dir=%s hf_endpoint=%s",
        name,
        cache_root,
        hf_endpoint or "default",
    )
    try:
        return SentenceTransformer(name)
    except Exception as exc:
        logger.error("embedding model load failed model=%s err=%s", name, exc)
        raise RuntimeError(
            f"无法加载 Embedding 模型 {name}（网络或缓存问题）。"
            "可设置 KB_EMBED_ENABLED=0 关闭向量检索，或配置 HF_ENDPOINT 镜像。"
        ) from exc


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


def embed_warmup_enabled() -> bool:
    raw = os.getenv("KB_EMBED_WARMUP", "1").strip().lower()
    return embed_enabled() and raw not in ("0", "false", "no", "off")


def embed_warmup_blocking_enabled() -> bool:
    """是否在启动阶段阻塞等待 embedding 预热完成。"""
    raw = os.getenv("KB_EMBED_WARMUP_BLOCKING", "0").strip().lower()
    return embed_warmup_enabled() and raw in ("1", "true", "yes", "on")


def embed_warmup_timeout_sec() -> float:
    """阻塞预热超时时间，0 或负值表示不设超时。"""
    raw = os.getenv("KB_EMBED_WARMUP_TIMEOUT_SEC", "180").strip()
    try:
        val = float(raw)
    except ValueError:
        val = 180.0
    return val


async def warmup_embed_model() -> None:
    """后台预加载 embedding 模型，避免首条 KB 查询冷启动。"""
    if not embed_warmup_enabled():
        return
    timeout_sec = embed_warmup_timeout_sec()
    try:
        if timeout_sec > 0:
            await asyncio.wait_for(asyncio.to_thread(embed_texts_sync, ["warmup"]), timeout=timeout_sec)
        else:
            await asyncio.to_thread(embed_texts_sync, ["warmup"])
        logger.info("kb embed model warmup ok model=%s", embed_model_name())
    except asyncio.TimeoutError:
        logger.warning("kb embed model warmup timeout model=%s timeout=%ss", embed_model_name(), timeout_sec)
    except Exception as e:
        logger.warning("kb embed model warmup failed: %s", e)


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
