"""图片 OCR 服务与上传接口测试。"""

import sys
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from backend import app
from backend.services.image_ocr import (
    ImageOcrError,
    build_ocr_markdown_body,
    image_md_filename,
    is_image_attachment,
    ocr_image_to_markdown,
    ocr_with_tesseract,
    resolve_ocr_engine,
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


def test_resolve_ocr_engine():
    with patch.dict("os.environ", {"IMAGE_OCR_ENGINE": "tesseract"}, clear=False):
        assert resolve_ocr_engine() == "tesseract"
    with patch.dict("os.environ", {"IMAGE_OCR_ENGINE": "vision"}, clear=False):
        assert resolve_ocr_engine() == "vision"
    with patch.dict("os.environ", {"IMAGE_OCR_ENGINE": "auto"}, clear=False):
        assert resolve_ocr_engine() == "auto"


def test_ocr_with_tesseract_success():
    fake_pytesseract = MagicMock()
    fake_pytesseract.get_tesseract_version.return_value = "5.3.0"
    fake_pytesseract.image_to_string.return_value = "识别结果\n第二行"
    fake_image = MagicMock()
    fake_image.mode = "RGB"
    fake_pil = MagicMock()
    fake_pil.Image.open.return_value = fake_image

    with patch.dict(sys.modules, {"pytesseract": fake_pytesseract, "PIL": fake_pil}):
        text = ocr_with_tesseract(b"img", filename="note.png")
    assert "识别结果" in text
    fake_pytesseract.image_to_string.assert_called_once()


@pytest.mark.asyncio
async def test_ocr_image_to_markdown_vision_success():
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
        {
            "IMAGE_OCR_ENGINE": "vision",
            "OPENROUTER_API_KEY": "sk-or-test",
            "IMAGE_OCR_MODEL": "google/gemini-2.5-flash",
            "HERMES_CHAT_API_URL": "",
        },
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
    posted_payload = mock_client.post.await_args.kwargs["json"]
    assert posted_payload["model"] == "google/gemini-2.5-flash"


@pytest.mark.asyncio
async def test_ocr_image_tesseract_engine():
    with patch.dict("os.environ", {"IMAGE_OCR_ENGINE": "tesseract"}, clear=False):
        with patch(
            "backend.services.image_ocr.ocr_with_tesseract",
            return_value="本地 OCR 文本",
        ) as mock_tesseract:
            text = await ocr_image_to_markdown(
                b"\x89PNG\r\n\x1a\n",
                content_type="image/png",
                filename="note.png",
            )
    assert "本地 OCR 文本" in text
    mock_tesseract.assert_called_once()


@pytest.mark.asyncio
async def test_ocr_auto_falls_back_to_tesseract_when_vision_missing():
    with patch.dict(
        "os.environ",
        {
            "IMAGE_OCR_ENGINE": "auto",
            "OPENROUTER_API_KEY": "",
            "IMAGE_OCR_API_URL": "",
            "AUXILIARY_VISION_BASE_URL": "",
        },
        clear=False,
    ):
        with patch(
            "backend.services.image_ocr.ocr_with_tesseract",
            return_value="回退 OCR",
        ) as mock_tesseract:
            text = await ocr_image_to_markdown(
                b"\x89PNG\r\n\x1a\n",
                content_type="image/png",
                filename="note.png",
            )
    assert "回退 OCR" in text
    mock_tesseract.assert_called_once()


@pytest.mark.asyncio
async def test_ocr_auto_falls_back_to_tesseract_when_vision_fails():
    fake_resp = {
        "choices": [
            {
                "message": {
                    "content": "未识别到图片。请重新上传包含文字的图片，我会提取其中的全部文字内容。",
                }
            }
        ],
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
        {
            "IMAGE_OCR_ENGINE": "auto",
            "OPENROUTER_API_KEY": "sk-or-test",
        },
        clear=False,
    ):
        with patch("backend.services.image_ocr.httpx.AsyncClient", return_value=mock_client):
            with patch(
                "backend.services.image_ocr.ocr_with_tesseract",
                return_value="Tesseract 回退",
            ) as mock_tesseract:
                text = await ocr_image_to_markdown(
                    b"\x89PNG\r\n\x1a\n",
                    content_type="image/png",
                    filename="note.png",
                )
    assert "Tesseract 回退" in text
    mock_tesseract.assert_called_once()


@pytest.mark.asyncio
async def test_ocr_vision_engine_rejects_bad_response():
    fake_resp = {
        "choices": [
            {
                "message": {
                    "content": "未识别到图片。请重新上传包含文字的图片，我会提取其中的全部文字内容。",
                }
            }
        ],
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
        {
            "IMAGE_OCR_ENGINE": "vision",
            "OPENROUTER_API_KEY": "sk-or-test",
        },
        clear=False,
    ):
        with patch("backend.services.image_ocr.httpx.AsyncClient", return_value=mock_client):
            with pytest.raises(ImageOcrError, match="ocr_vision_unavailable"):
                await ocr_image_to_markdown(
                    b"\x89PNG\r\n\x1a\n",
                    content_type="image/png",
                    filename="note.png",
                )


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
