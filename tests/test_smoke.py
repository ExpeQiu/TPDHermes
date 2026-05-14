"""最小冒烟：根路径、健康检查、版本化项目与技能列表。"""

from fastapi.testclient import TestClient

from backend import app


def test_root():
    with TestClient(app) as client:
        r = client.get("/")
        assert r.status_code == 200
        body = r.json()
        assert body.get("code") == 0
        assert body.get("data", {}).get("status") == "running"


def test_health():
    with TestClient(app) as client:
        r = client.get("/health")
        assert r.status_code == 200
        body = r.json()
        assert body.get("code") == 0
        assert "checks" in (body.get("data") or {})


def test_projects_v1():
    with TestClient(app) as client:
        r = client.get("/api/v1/projects/")
        assert r.status_code == 200
        assert isinstance(r.json(), list)


def test_skills_v1():
    with TestClient(app) as client:
        r = client.get("/api/v1/skills/")
        assert r.status_code == 200
        assert isinstance(r.json(), list)
