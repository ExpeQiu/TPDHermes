"""PDF/DOC/DOCX/HTML/文本 → Markdown 抽取。"""

from __future__ import annotations

import logging
import re
import shutil
import subprocess
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

logger = logging.getLogger("tpdx.hermes.document_extract")

_TEXT_SUFFIXES = {".txt", ".text", ".md", ".markdown", ".csv", ".json", ".log"}
_PDF_SUFFIXES = {".pdf"}
_DOCX_SUFFIXES = {".docx"}
_DOC_SUFFIXES = {".doc"}
_RTF_SUFFIXES = {".rtf"}
_HTML_SUFFIXES = {".html", ".htm"}
_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff"}

KB_UPLOAD_FORMATS = "md、txt、doc、docx、pdf、html、rtf"


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

    if suf in _HTML_SUFFIXES or "html" in ct:
        return _extract_html(path)

    if suf in _TEXT_SUFFIXES or (ct.startswith("text/") and "rtf" not in ct):
        try:
            return path.read_text(encoding="utf-8", errors="replace").strip()
        except OSError as e:
            raise DocumentExtractError(f"read_error:{e}") from e

    if suf in _PDF_SUFFIXES or "pdf" in ct:
        return _extract_pdf(path)

    if suf in _DOCX_SUFFIXES or "wordprocessingml" in ct:
        return _extract_docx(path)

    if suf in _DOC_SUFFIXES or ct == "application/msword":
        return _extract_textutil(path, empty_code="doc_empty_text")

    if suf in _RTF_SUFFIXES or "rtf" in ct:
        return _extract_textutil(path, empty_code="rtf_empty_text")

    if suf in _IMAGE_SUFFIXES or ct.startswith("image/"):
        return _extract_image(path, content_type=content_type)

    raise DocumentExtractError(f"unsupported_format:{suf or ct or 'unknown'}")


def prepare_kb_ingest_file(src: Path, *, content_type: str | None = None) -> tuple[Path, dict[str, Any]]:
    """返回入库应读取的路径。纯文本保持原文件，其他文档写成同目录 `.extracted.md`。"""
    if not src.is_file():
        raise DocumentExtractError(f"file_not_found:{src}")

    suf = _suffix(src)
    ct = (content_type or "").lower()
    if suf in _IMAGE_SUFFIXES or ct.startswith("image/"):
        raise DocumentExtractError(f"unsupported_format:{suf or ct or 'image'}")

    text = extract_to_markdown(src, content_type=content_type).strip()
    if not text:
        raise DocumentExtractError("empty_text")

    text_like = suf in _TEXT_SUFFIXES or (
        ct.startswith("text/") and suf not in _HTML_SUFFIXES and suf not in _RTF_SUFFIXES
    )
    meta: dict[str, Any] = {
        "source_format": suf.lstrip(".") or "text",
        "char_count": len(text),
        "extracted": not text_like,
    }
    if text_like:
        logger.info(
            "kb_upload_prepare keep_original name=%s format=%s chars=%s",
            src.name,
            meta["source_format"],
            meta["char_count"],
        )
        return src, meta

    dest = src.with_name(f"{src.name}.extracted.md")
    dest.write_text(text, encoding="utf-8")
    logger.info(
        "kb_upload_prepare extracted name=%s format=%s chars=%s out=%s",
        src.name,
        meta["source_format"],
        meta["char_count"],
        dest.name,
    )
    return dest, meta


def kb_upload_error_message(exc: DocumentExtractError) -> str:
    err = str(exc)
    if err.startswith("unsupported_format"):
        return f"暂不支持该格式。请上传 {KB_UPLOAD_FORMATS}。"
    if "empty_text" in err:
        return "文件没有可导入的文本。"
    if "textutil_not_available" in err:
        return "当前环境无法读取旧版 .doc / .rtf，请另存为 .docx 后上传。"
    if err == "python_docx_not_installed":
        return "未安装 Word 解析组件。"
    if err == "pymupdf_not_installed":
        return "未安装 PDF 解析组件。"
    return f"文件解析失败：{err}"


def _extract_html(path: Path) -> str:
    class _TextParser(HTMLParser):
        def __init__(self) -> None:
            super().__init__(convert_charrefs=True)
            self.parts: list[str] = []
            self._skip = 0

        def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
            if tag in {"script", "style", "noscript"}:
                self._skip += 1
            if tag in {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "section"}:
                self.parts.append("\n")

        def handle_endtag(self, tag: str) -> None:
            if tag in {"script", "style", "noscript"} and self._skip:
                self._skip -= 1
            if tag in {"p", "div", "li", "h1", "h2", "h3", "h4"}:
                self.parts.append("\n")

        def handle_data(self, data: str) -> None:
            if not self._skip:
                self.parts.append(data)

    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        raise DocumentExtractError(f"read_error:{e}") from e

    parser = _TextParser()
    parser.feed(raw)
    body = re.sub(r"\n{3,}", "\n\n", "".join(parser.parts)).strip()
    if not body:
        raise DocumentExtractError("html_empty_text")
    return body


def _extract_textutil(path: Path, *, empty_code: str) -> str:
    binary = shutil.which("textutil")
    if not binary:
        raise DocumentExtractError("textutil_not_available")
    try:
        proc = subprocess.run(
            [binary, "-convert", "txt", "-stdout", str(path)],
            capture_output=True,
            text=True,
            timeout=90,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as e:
        raise DocumentExtractError(f"textutil_failed:{e}") from e
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()[:300]
        raise DocumentExtractError(f"textutil_failed:{err or proc.returncode}")
    body = (proc.stdout or "").strip()
    if not body:
        raise DocumentExtractError(empty_code)
    logger.info("document_extract textutil name=%s chars=%s", path.name, len(body))
    return body


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
