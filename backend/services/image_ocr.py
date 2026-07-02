"""图片 OCR → Markdown（支持 Tesseract 本地引擎与云端视觉模型）。"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import mimetypes
import os
import re
from io import BytesIO
from pathlib import Path
from urllib.parse import urlparse

import httpx

from backend.env_policy import allow_missing_chat_upstream

logger = logging.getLogger("tpdx.hermes.image_ocr")

_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff"}
_DEFAULT_VISION_MODEL = "google/gemini-2.5-flash"
_OCR_PROMPT = (
    "请将图片中的全部文字内容提取出来，输出为 Markdown 格式。要求：\n"
    "1. 保留标题层级、列表、表格等结构\n"
    "2. 表格用 Markdown 表格语法\n"
    "3. 只输出提取的文字内容，不要添加解释或评论\n"
    "4. 若图片无文字，输出「（未识别到文字）」"
)
_VISION_UNAVAILABLE_MARKERS = (
    "未识别到图片",
    "重新上传包含文字的图片",
    "无法查看图片",
    "无法识别图片",
    "看不到图片",
    "没有看到图片",
    "没有收到图片",
    "cannot see the image",
    "can't see the image",
    "unable to view the image",
)
_VISION_FALLBACK_ERRORS = frozenset(
    {
        "ocr_vision_not_configured",
        "ocr_vision_unavailable",
        "ocr_agent_gateway_not_supported",
        "ocr_empty_response",
        "ocr_invalid_json",
        "ocr_empty_text",
    }
)


class ImageOcrError(Exception):
    pass


def image_ocr_enabled() -> bool:
    raw = os.getenv("IMAGE_OCR_ENABLED", "1").strip().lower()
    return raw not in ("0", "false", "no", "off")


def resolve_ocr_engine() -> str:
    """返回 tesseract | vision | auto。"""
    raw = os.getenv("IMAGE_OCR_ENGINE", "auto").strip().lower()
    if raw in {"tesseract", "local"}:
        return "tesseract"
    if raw in {"vision", "cloud", "remote"}:
        return "vision"
    return "auto"


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


def _normalize_chat_completions_url(raw_url: str) -> str:
    url = raw_url.strip().rstrip("/")
    if not url:
        return ""
    if url.endswith("/chat/completions"):
        return url
    return f"{url}/chat/completions"


def _default_vision_model() -> str:
    return (
        os.getenv("IMAGE_OCR_MODEL", "").strip()
        or os.getenv("HERMES_VISION_MODEL", "").strip()
        or _DEFAULT_VISION_MODEL
    )


def _looks_like_agent_gateway(url: str) -> bool:
    """Hermes /v1/chat/completions 会走 Agent 循环，文本模型无法稳定 OCR。"""
    parsed = urlparse(url.strip())
    host = (parsed.hostname or "").lower()
    path = (parsed.path or "").lower()
    if not path.endswith("/chat/completions"):
        return False
    if host in {"hermes-agent", "127.0.0.1", "localhost"}:
        return True
    if "hermes-agent" in host:
        return True
    chat_url = os.getenv("HERMES_CHAT_API_URL", "").strip()
    return bool(chat_url and url.rstrip("/") == chat_url.rstrip("/"))


def _resolve_ocr_upstream() -> tuple[str, str, str]:
    """解析 OCR 直连上游，返回 (url, api_key, model)。"""
    explicit_url = _normalize_chat_completions_url(os.getenv("IMAGE_OCR_API_URL", ""))
    explicit_key = os.getenv("IMAGE_OCR_API_KEY", "").strip()
    model = _default_vision_model()
    if explicit_url:
        if _looks_like_agent_gateway(explicit_url) and os.getenv("IMAGE_OCR_ALLOW_AGENT_GATEWAY", "").strip().lower() not in (
            "1",
            "true",
            "yes",
        ):
            raise ImageOcrError("ocr_agent_gateway_not_supported")
        return explicit_url, explicit_key, model

    openrouter_key = os.getenv("OPENROUTER_API_KEY", "").strip()
    if openrouter_key:
        base = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1").strip().rstrip("/")
        return _normalize_chat_completions_url(base), openrouter_key, model

    aux_base = os.getenv("AUXILIARY_VISION_BASE_URL", "").strip()
    if aux_base:
        aux_key = os.getenv("AUXILIARY_VISION_API_KEY", "").strip()
        aux_model = os.getenv("AUXILIARY_VISION_MODEL", "").strip() or model
        return _normalize_chat_completions_url(aux_base), aux_key, aux_model

    if allow_missing_chat_upstream():
        raise ImageOcrError("ocr_vision_not_configured")
    raise ImageOcrError("ocr_vision_not_configured")


def vision_upstream_configured() -> bool:
    try:
        _resolve_ocr_upstream()
    except ImageOcrError:
        return False
    return True


def _tesseract_lang() -> str:
    return os.getenv("IMAGE_OCR_TESSERACT_LANG", "chi_sim+eng").strip() or "chi_sim+eng"


def _tesseract_psm() -> str:
    return os.getenv("IMAGE_OCR_TESSERACT_PSM", "3").strip() or "3"


def _normalize_tesseract_text(text: str) -> str:
    lines = [ln.rstrip() for ln in text.splitlines()]
    cleaned = "\n".join(lines).strip()
    return re.sub(r"\n{3,}", "\n\n", cleaned)


def ocr_with_tesseract(content: bytes, *, filename: str) -> str:
    """本地 Tesseract OCR。"""
    try:
        import pytesseract
        from PIL import Image
    except ImportError as exc:
        raise ImageOcrError("ocr_tesseract_not_installed") from exc

    cmd = os.getenv("TESSERACT_CMD", "").strip()
    if cmd:
        pytesseract.pytesseract.tesseract_cmd = cmd

    try:
        pytesseract.get_tesseract_version()
    except Exception as exc:
        raise ImageOcrError("ocr_tesseract_binary_missing") from exc

    try:
        image = Image.open(BytesIO(content))
    except Exception as exc:
        raise ImageOcrError(f"ocr_image_decode_failed:{exc}") from exc

    if image.mode not in {"RGB", "L"}:
        image = image.convert("RGB")

    lang = _tesseract_lang()
    config = f"--psm {_tesseract_psm()}"
    logger.info(
        "[image-ocr] tesseract start filename=%s size=%s lang=%s psm=%s",
        filename,
        len(content),
        lang,
        _tesseract_psm(),
    )
    try:
        raw = pytesseract.image_to_string(image, lang=lang, config=config)
    except Exception as exc:
        raise ImageOcrError(f"ocr_tesseract_failed:{exc}") from exc

    text = _normalize_tesseract_text(raw)
    if not text:
        raise ImageOcrError("ocr_empty_text")
    logger.info("[image-ocr] tesseract ok filename=%s chars=%s", filename, len(text))
    return text


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


def _validate_ocr_text(text: str) -> str:
    cleaned = (text or "").strip()
    if not cleaned:
        raise ImageOcrError("ocr_empty_text")
    lowered = cleaned.lower()
    if any(marker in cleaned or marker in lowered for marker in _VISION_UNAVAILABLE_MARKERS):
        raise ImageOcrError("ocr_vision_unavailable")
    return cleaned


def _should_fallback_to_tesseract(exc: ImageOcrError) -> bool:
    code = str(exc)
    if code in _VISION_FALLBACK_ERRORS:
        return True
    if code.startswith("ocr_upstream_http_"):
        return True
    if code.startswith("ocr_upstream_error:"):
        return True
    return False


async def _ocr_with_vision_api(
    content: bytes,
    *,
    content_type: str,
    filename: str,
) -> str:
    target_url, api_key, model = _resolve_ocr_upstream()
    mime = (content_type or "image/png").split(";")[0].strip() or "image/png"
    if not mime.startswith("image/"):
        mime = "image/png"
    b64 = base64.b64encode(content).decode("ascii")
    data_url = f"data:{mime};base64,{b64}"

    payload = {
        "model": model,
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
        "[image-ocr] vision start filename=%s size=%s mime=%s model=%s upstream=%s",
        filename,
        len(content),
        mime,
        model,
        target_url,
    )

    try:
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            resp = await client.post(target_url, headers=headers, json=payload)
    except httpx.HTTPError as exc:
        logger.warning("[image-ocr] vision upstream error filename=%s err=%s", filename, exc)
        raise ImageOcrError(f"ocr_upstream_error:{exc}") from exc

    if resp.status_code >= 400:
        detail = resp.text[:300]
        logger.warning(
            "[image-ocr] vision upstream http=%s filename=%s detail=%s",
            resp.status_code,
            filename,
            detail,
        )
        raise ImageOcrError(f"ocr_upstream_http_{resp.status_code}")

    try:
        data = resp.json()
    except json.JSONDecodeError as exc:
        raise ImageOcrError("ocr_invalid_json") from exc

    text = _validate_ocr_text(_strip_code_fence(_extract_completion_text(data)))
    logger.info("[image-ocr] vision ok filename=%s chars=%s", filename, len(text))
    return text


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

    engine = resolve_ocr_engine()

    if engine == "tesseract":
        text = ocr_with_tesseract(content, filename=filename)
        return build_ocr_markdown_body(text, source_filename=filename)

    if engine == "vision":
        text = await _ocr_with_vision_api(content, content_type=content_type, filename=filename)
        return build_ocr_markdown_body(text, source_filename=filename)

    # auto：有云端视觉则优先，失败或未配置时回退 Tesseract
    if vision_upstream_configured():
        try:
            text = await _ocr_with_vision_api(content, content_type=content_type, filename=filename)
            return build_ocr_markdown_body(text, source_filename=filename)
        except ImageOcrError as exc:
            if not _should_fallback_to_tesseract(exc):
                raise
            logger.warning(
                "[image-ocr] vision failed, fallback tesseract filename=%s err=%s",
                filename,
                exc,
            )

    text = ocr_with_tesseract(content, filename=filename)
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
