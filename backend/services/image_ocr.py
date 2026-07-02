"""图片 OCR → Markdown（经 Hermes 视觉模型）。"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import mimetypes
import os
import re
from pathlib import Path

import httpx

from backend.env_policy import allow_missing_chat_upstream

logger = logging.getLogger("tpdx.hermes.image_ocr")

_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff"}
_OCR_PROMPT = (
    "请将图片中的全部文字内容提取出来，输出为 Markdown 格式。要求：\n"
    "1. 保留标题层级、列表、表格等结构\n"
    "2. 表格用 Markdown 表格语法\n"
    "3. 只输出提取的文字内容，不要添加解释或评论\n"
    "4. 若图片无文字，输出「（未识别到文字）」"
)


class ImageOcrError(Exception):
    pass


def image_ocr_enabled() -> bool:
    raw = os.getenv("IMAGE_OCR_ENABLED", "1").strip().lower()
    return raw not in ("0", "false", "no", "off")


def is_image_attachment(path: Path | str, content_type: str | None = None) -> bool:
    ct = (content_type or "").lower()
    if ct.startswith("image/"):
        return True
    suf = Path(path).suffix.lower()
    return suf in _IMAGE_SUFFIXES


def image_md_filename(original_filename: str) -> str:
    base = (original_filename or "image").replace("\\", "_").replace("/", "_").strip() or "image"
    stem = Path(base).stem or "image"
    return f"{stem}.md"


def build_ocr_markdown_body(text: str, *, source_filename: str) -> str:
    body = (text or "").strip() or "（未识别到文字）"
    source = (source_filename or "image").strip()
    return "\n".join(
        [
            f"<!-- OCR source: {source} -->",
            "",
            body,
        ]
    ).strip()


def _resolve_vision_target() -> tuple[str, str]:
    url = os.getenv("HERMES_CHAT_API_URL", "").strip()
    api_key = os.getenv("HERMES_CHAT_API_KEY", "").strip()
    if not url:
        if allow_missing_chat_upstream():
            raise ImageOcrError("ocr_upstream_not_configured")
        raise ImageOcrError("HERMES_CHAT_API_URL not configured")
    return url, api_key


def _resolve_vision_model() -> str:
    return (
        os.getenv("HERMES_VISION_MODEL", "").strip()
        or os.getenv("HERMES_CHAT_MODEL", "").strip()
        or "hermes-agent"
    )


def _guess_image_mime(path: Path, content_type: str | None) -> str:
    ct = (content_type or "").strip()
    if ct.startswith("image/"):
        return ct
    guessed, _ = mimetypes.guess_type(str(path))
    if guessed and guessed.startswith("image/"):
        return guessed
    return "image/png"


def _extract_completion_text(payload: dict) -> str:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        raise ImageOcrError("ocr_empty_response")
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    if not isinstance(message, dict):
        raise ImageOcrError("ocr_empty_response")
    content = message.get("content")
    if isinstance(content, str):
        text = content.strip()
        if text:
            return text
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text":
                parts.append(str(block.get("text") or ""))
        text = "\n".join(p for p in parts if p.strip()).strip()
        if text:
            return text
    raise ImageOcrError("ocr_empty_response")


def _strip_code_fence(text: str) -> str:
    cleaned = text.strip()
    match = re.match(r"^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$", cleaned, re.IGNORECASE)
    if match:
        return match.group(1).strip()
    return cleaned


async def ocr_image_to_markdown(
    content: bytes,
    *,
    content_type: str,
    filename: str,
) -> str:
    if not image_ocr_enabled():
        raise ImageOcrError("ocr_disabled")
    if not content:
        raise ImageOcrError("empty_image")
    max_bytes = max(1024, int(os.getenv("IMAGE_OCR_MAX_BYTES", str(10 * 1024 * 1024))))
    if len(content) > max_bytes:
        raise ImageOcrError("image_too_large")

    target_url, api_key = _resolve_vision_target()
    mime = (content_type or "image/png").split(";")[0].strip() or "image/png"
    if not mime.startswith("image/"):
        mime = "image/png"
    b64 = base64.b64encode(content).decode("ascii")
    data_url = f"data:{mime};base64,{b64}"

    payload = {
        "model": _resolve_vision_model(),
        "stream": False,
        "max_tokens": max(512, int(os.getenv("IMAGE_OCR_MAX_TOKENS", "4096"))),
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": _OCR_PROMPT},
                    {"type": "image_url", "image_url": {"url": data_url}},
                ],
            }
        ],
    }
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    timeout_s = max(10.0, float(os.getenv("IMAGE_OCR_TIMEOUT", "120")))
    timeout = httpx.Timeout(connect=10.0, read=timeout_s, write=30.0, pool=10.0)
    logger.info(
        "[image-ocr] start filename=%s size=%s mime=%s model=%s",
        filename,
        len(content),
        mime,
        payload["model"],
    )

    try:
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            resp = await client.post(target_url, headers=headers, json=payload)
    except httpx.HTTPError as exc:
        logger.warning("[image-ocr] upstream error filename=%s err=%s", filename, exc)
        raise ImageOcrError(f"ocr_upstream_error:{exc}") from exc

    if resp.status_code >= 400:
        detail = resp.text[:300]
        logger.warning(
            "[image-ocr] upstream http=%s filename=%s detail=%s",
            resp.status_code,
            filename,
            detail,
        )
        raise ImageOcrError(f"ocr_upstream_http_{resp.status_code}")

    try:
        data = resp.json()
    except json.JSONDecodeError as exc:
        raise ImageOcrError("ocr_invalid_json") from exc

    text = _strip_code_fence(_extract_completion_text(data))
    logger.info("[image-ocr] ok filename=%s chars=%s", filename, len(text))
    return build_ocr_markdown_body(text, source_filename=filename)


def ocr_image_file_sync(path: Path, *, content_type: str | None = None) -> str:
    if not path.is_file():
        raise ImageOcrError("file_not_found")
    mime = _guess_image_mime(path, content_type)
    content = path.read_bytes()

    async def _run() -> str:
        return await ocr_image_to_markdown(
            content,
            content_type=mime,
            filename=path.name,
        )

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(_run())

    import concurrent.futures

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, _run()).result()
