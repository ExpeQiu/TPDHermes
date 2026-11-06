"""场景创作技能卡：默认只开放可验证卡片，保存后按开关生效。"""

from fastapi.testclient import TestClient

from backend import app
from backend.services.studio_skill_release import public_release


def _isolate(monkeypatch, tmp_path):
    monkeypatch.setenv("TPDHERMES_STUDIO_SKILLS_CONFIG", str(tmp_path / "studio-skills.json"))


def test_default_opens_only_ready_cards(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)
    payload = public_release()
    opened = [row["id"] for row in payload["skills"] if row["released"]]
    assert payload["data_source"] == "default"
    assert opened == ["V04"]
    assert len(payload["skills"]) == 21


def test_release_toggle_persists(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)
    with TestClient(app) as client:
        saved = client.put("/api/v1/system/studio-skills", json={"released": {"V01": True, "V04": False}})
        assert saved.status_code == 200
        body = saved.json()
        flags = {row["id"]: row["released"] for row in body["skills"]}
        assert flags["V01"] is True
        assert flags["V04"] is False
        assert body["data_source"] == "saved"
        again = client.get("/api/v1/system/studio-skills")
        again_flags = {row["id"]: row["released"] for row in again.json()["skills"]}
        assert again_flags["V01"] is True
        assert again_flags["V04"] is False


def test_unknown_skill_rejected(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)
    with TestClient(app) as client:
        rejected = client.put("/api/v1/system/studio-skills", json={"released": {"V99": True}})
        assert rejected.status_code == 400
