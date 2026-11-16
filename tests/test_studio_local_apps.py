"""本机应用右栏只接受回环地址，未启动时返回未就绪。"""

from urllib.error import URLError

from fastapi.testclient import TestClient

from backend import app
from backend.services import studio_local_apps


def test_remote_workbench_rejected(monkeypatch):
    monkeypatch.setenv("SPEECH_STUDIO_URL", "http://example.com")
    with TestClient(app) as client:
        response = client.get("/api/v1/studio/local-apps/V14")
    assert response.status_code == 422


def test_down_app_reports_url(monkeypatch):
    def fail(*_args, **_kwargs):
        raise URLError("refused")

    monkeypatch.setattr(studio_local_apps, "urlopen", fail)
    with TestClient(app) as client:
        response = client.get("/api/v1/studio/local-apps/V18")
    assert response.status_code == 200
    body = response.json()
    assert body["ready"] is False
    assert body["phase"] == "idle"
    assert body["url"] == "http://127.0.0.1:4318"
