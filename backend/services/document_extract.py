"""PDF/DOCX/文本 → Markdown 抽取。"""

from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger("tpdx.hermes.document_extract")

_TEXT_SUFFIXES = {".txt", ".md", ".markdown", ".csv", ".json"}
_PDF_SUFFIXES = {".pdf"}
_DOCX_SUFFIXES = {".docx"}
_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff"}


class DocumentExtractError(Exception):
    pass


def _suffix(path: Path) -> str:
    return path.suffix.lower()


def extract_to_markdown(path: Path, *, content_type: str | None = None) -> str:
    """将文件抽取为 markdown 文本；不支持格式抛出 DocumentExtractError。"""
    if not path.is_file():
        raise DocumentExtractError(f"file_not_found:{path}")

    suf = _suffix(path)
    ct = (content_type or "").lower()

    if suf in _TEXT_SUFFIXES or ct.startswith("text/"):
        try:
            return path.read_text(encoding="utf-8", errors="replace").strip()
        except OSError as e:
            raise DocumentExtractError(f"read_error:{e}") from e

    if suf in _PDF_SUFFIXES or "pdf" in ct:
        return _extract_pdf(path)

    if suf in _DOCX_SUFFIXES or "wordprocessingml" in ct:
        return _extract_docx(path)

    if suf in _IMAGE_SUFFIXES or ct.startswith("image/"):
        return _extract_image(path, content_type=content_type)

    raise DocumentExtractError(f"unsupported_format:{suf or ct or 'unknown'}")


def _extract_pdf(path: Path) -> str:
    try:
        import fitz  # pymupdf
    except ImportError as e:
        raise DocumentExtractError("pymupdf_not_installed") from e

    parts: list[str] = []
    try:
        doc = fitz.open(str(path))
        for i, page in enumerate(doc):
            text = (page.get_text() or "").strip()
            if text:
                parts.append(f"## 第 {i + 1} 页\n\n{text}")
        doc.close()
    except Exception as e:
        raise DocumentExtractError(f"pdf_extract_failed:{e}") from e

    body = "\n\n".join(parts).strip()
    if not body:
        raise DocumentExtractError("pdf_empty_text")
    return body


def _extract_docx(path: Path) -> str:
    try:
        from docx import Document
    except ImportError as e:
        raise DocumentExtractError("python_docx_not_installed") from e

    try:
        doc = Document(str(path))
    except Exception as e:
        raise DocumentExtractError(f"docx_open_failed:{e}") from e

    parts: list[str] = []
    for para in doc.paragraphs:
        text = (para.text or "").strip()
        if not text:
            continue
        style = (para.style.name or "").lower() if para.style else ""
        if "heading" in style:
            level = 2
            for ch in style:
                if ch.isdigit():
                    level = min(int(ch), 4)
                    break
            parts.append(f"{'#' * level} {text}")
        else:
            parts.append(text)

    body = "\n\n".join(parts).strip()
    if not body:
        raise DocumentExtractError("docx_empty_text")
    return body


def _extract_image(path: Path, *, content_type: str | None = None) -> str:
    from backend.services.image_ocr import ImageOcrError, ocr_image_file_sync

    try:
        return ocr_image_file_sync(path, content_type=content_type)
    except ImageOcrError as e:
        raise DocumentExtractError(f"image_ocr_failed:{e}") from e
