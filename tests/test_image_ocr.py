"""图片 OCR 服务与上传接口测试。"""

from __future__ import annotations

import uuid
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from backend import app
from backend.services.image_ocr import (
    ImageOcrError,
    build_ocr_markdown_body,
    image_md_filename,
    is_image_attachment,
    ocr_image_to_markdown,
)


def test_is_image_attachment():
    assert is_image_attachment("scan.png", "image/png") is True
    assert is_image_attachment("doc.pdf", "application/pdf") is False


def test_image_md_filename():
    assert image_md_filename("photo.JPG") == "photo.md"


def test_build_ocr_markdown_body():
    body = build_ocr_markdown_body("# Title\n\nhello", source_filename="a.png")
    assert "OCR source: a.png" in body
    assert "# Title" in body


@pytest.mark.asyncio
async def test_ocr_image_to_markdown_success():
    fake_resp = {
        "choices": [{"message": {"content": "```markdown\n# OCR\n\nline1\n```"}}],
    }

    class FakeResponse:
        status_code = 200

        def json(self):
            return fake_resp

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=FakeResponse())
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=None)

    with patch.dict(
        "os.environ",
        {"HERMES_CHAT_API_URL": "http://127.0.0.1:8642/v1/chat/completions"},
        clear=False,
    ):
        with patch("backend.services.image_ocr.httpx.AsyncClient", return_value=mock_client):
            text = await ocr_image_to_markdown(
                b"\x89PNG\r\n\x1a\n",
                content_type="image/png",
                filename="note.png",
            )
    assert "# OCR" in text
    assert "line1" in text


@pytest.mark.asyncio
async def test_ocr_image_upstream_missing():
    with patch.dict("os.environ", {"HERMES_CHAT_API_URL": ""}, clear=False):
        with pytest.raises(ImageOcrError, match="ocr_upstream_not_configured"):
            await ocr_image_to_markdown(b"123", content_type="image/png", filename="a.png")


@patch("backend.services.image_ocr.ocr_image_to_markdown", new_callable=AsyncMock)
def test_upload_attachment_with_ocr(mock_ocr):
    mock_ocr.return_value = build_ocr_markdown_body("识别文字", source_filename="scan.png")
    with TestClient(app) as client:
        pr = client.post("/api/v1/projects/", json={"name": "OCR项目"}).json()
        pid = pr["id"]
        files = {"file": ("scan.png", b"\x89PNG\r\n\x1a\n", "image/png")}
        up = client.post(f"/api/v1/projects/{pid}/attachments?ocr=true", files=files)
    assert up.status_code == 200, up.text
    data = up.json()
    assert data["original_filename"] == "scan.md"
    assert data["content_type"] == "text/markdown"
    mock_ocr.assert_awaited_once()


def test_extract_image_in_document_extract(tmp_path: Path):
    from backend.services.document_extract import extract_to_markdown

    img = tmp_path / "pic.png"
    img.write_bytes(b"\x89PNG\r\n\x1a\n")
    with patch(
        "backend.services.image_ocr.ocr_image_file_sync",
        return_value=build_ocr_markdown_body("hello ocr", source_filename="pic.png"),
    ):
        text = extract_to_markdown(img, content_type="image/png")
    assert "hello ocr" in text
