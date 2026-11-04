"""真实跨仓库 CLI 子进程 + 受控模型服务；不是付费真实模型验收。"""

from __future__ import annotations

import asyncio
import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import app
from backend.db import async_session_maker
from backend.models.output_asset import OutputAsset


@pytest.fixture
def bridge(monkeypatch):
    root = Path(__file__).resolve().parents[1].parents[1] / "10 baseTools" / "TPCstore"
    if not (root / "V04-tech-cards/cli.mjs").is_file():
        pytest.skip("跨仓库集成需相邻检出 TPCstore")
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(body)
            if self.path == "/unauthorized":
                self.send_response(401)
                self.end_headers()
                return
            content = body["messages"][-1]["content"]
            sid = content.splitlines()[0].split("=", 1)[1]
            text = content.split("1: ", 1)[1].splitlines()[0]
            term = text.split("采用")[0]
            result = {
                "cards": [
                    {
                        "term": term,
                        "domain": "夹具",
                        "fields": {
                            "definition": {
                                "value": text,
                                "source_id": sid,
                                "line_start": 1,
                                "line_end": 1,
                                "quote": text,
                            },
                            "principle": None,
                            "parameter": None,
                            "scope": None,
                        },
                    }
                ],
                "issues": [],
            }
            payload = {
                "model": "fixture",
                "id": "fixture-response",
                "choices": [{"message": {"content": json.dumps(result)}}],
            }
            data = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("TPCSTORE_ROOT", str(root))
    monkeypatch.setenv(
        "TPCSTORE_MODEL_URL", f"http://127.0.0.1:{server.server_port}/ok"
    )
    monkeypatch.setenv("TPCSTORE_MODEL_KEY", "fixture-key-no-real-secret")
    yield requests, server.server_port
    server.shutdown()
    server.server_close()
    thread.join(timeout=2)


def seed_file(client, user, text="桥接夹具A采用分层设计。"):
    headers = {"X-User-ID": user}
    response = client.post(
        "/api/v1/projects/", json={"name": "TPCstore 通路"}, headers=headers
    )
    assert response.status_code == 200, response.text
    project_id = response.json()["id"]
    file_id = str(uuid.uuid4())

    async def insert():
        async with async_session_maker() as db:
            db.add(
                OutputAsset(
                    id=file_id,
                    project_id=project_id,
                    title="通路输入.md",
                    content=text,
                    owner_id=user,
                    status="draft",
                    version="1",
                )
            )
            await db.commit()

    asyncio.run(insert())
    return headers, {
        "message": "提取技术卡",
        "project_id": project_id,
        "file_id": file_id,
        "file_kind": "output",
    }


def test_cross_repository_source_roundtrip_and_lock(bridge):
    with TestClient(app) as client:
        config = client.get("/api/v1/studio/config").json()
        assert config["connected"] and config["driver"] == "tpcstore"
        headers, payload = seed_file(client, "bridge-owner-" + uuid.uuid4().hex)
        response = client.post("/api/v1/studio/turn", json=payload, headers=headers)
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["driver"] == "tpcstore" and result["fallback_reason"] is None
        assert result["source"]["id"] == payload["file_id"]
        assert result["state"]["cards"][0]["term"] == "桥接夹具A"
        assert result["state"]["cards"][0]["sources"]["definition"]["line_start"] == 1
        assert (
            not result["release_authorized"]
            and result["persistence"] == "session_preview"
        )
        locked = client.post(
            "/api/v1/studio/turn",
            json={**payload, "message": "锁定当前卡", "state": result["state"]},
            headers=headers,
        )
        assert locked.status_code == 200, locked.text
        assert locked.json()["state"]["cards"][0]["status"] == "locked"
        assert len(bridge[0]) == 1
        _, other = seed_file(client, headers["X-User-ID"], "桥接夹具B采用另一种结构。")
        changed = client.post("/api/v1/studio/turn", json=other, headers=headers)
        assert changed.status_code == 200
        assert changed.json()["state"]["cards"][0]["term"] == "桥接夹具B"


def test_foreign_project_and_cross_project_file_are_rejected(bridge):
    with TestClient(app) as client:
        headers, payload = seed_file(client, "bridge-acl-" + uuid.uuid4().hex)
        stranger = client.post(
            "/api/v1/studio/turn",
            json=payload,
            headers={"X-User-ID": "bridge-stranger"},
        )
        assert stranger.status_code == 404
        _, other = seed_file(client, headers["X-User-ID"])
        crossed = client.post(
            "/api/v1/studio/turn",
            json={**payload, "file_id": other["file_id"]},
            headers=headers,
        )
        assert crossed.status_code == 404
        assert not bridge[0]


def test_missing_source_and_upstream_auth_fail_closed(bridge, monkeypatch):
    with TestClient(app) as client:
        missing = client.post("/api/v1/studio/turn", json={"message": "提取技术卡"})
        assert missing.status_code == 422
        headers, payload = seed_file(client, "bridge-auth-" + uuid.uuid4().hex)
        monkeypatch.setenv(
            "TPCSTORE_MODEL_URL", f"http://127.0.0.1:{bridge[1]}/unauthorized"
        )
        failed = client.post("/api/v1/studio/turn", json=payload, headers=headers)
        assert failed.status_code == 502
        assert "AUTH_REQUIRED" in failed.text
        assert "800V" not in failed.text and "fixture-key" not in failed.text
        assert len(bridge[0]) == 1


def test_explicit_demo_cannot_mix_project_data():
    with TestClient(app) as client:
        demo = client.post(
            "/api/v1/studio/turn", json={"message": "提取技术卡", "demo": True}
        )
        assert demo.status_code == 200 and demo.json()["driver"] == "mock"
        assert demo.json()["release_authorized"] is False
        mixed = client.post(
            "/api/v1/studio/turn",
            json={"message": "提取技术卡", "demo": True, "project_id": "p"},
        )
        assert mixed.status_code == 422


def test_protected_gateway_config_is_read_fresh(monkeypatch, tmp_path):
    from backend.services.tpcstore_bridge import _child_env

    config = tmp_path / "protected.env"
    monkeypatch.delenv("TPCSTORE_MODEL_KEY", raising=False)
    monkeypatch.setenv("TPCSTORE_MODEL_ENV_FILE", str(config))
    monkeypatch.setenv("HERMES_CHAT_API_KEY", "stale-fixture")
    config.write_text("API_SERVER_KEY=fixture-one\n")
    assert _child_env()["TPCSTORE_MODEL_KEY"] == "fixture-one"
    config.write_text("API_SERVER_KEY=fixture-two\n")
    assert _child_env()["TPCSTORE_MODEL_KEY"] == "fixture-two"


def test_attachment_text_comes_from_authorized_file(bridge, monkeypatch, tmp_path):
    from backend.models.project_attachment import ProjectAttachment

    monkeypatch.setenv("PROJECT_UPLOAD_DIR", str(tmp_path))
    with TestClient(app) as client:
        headers, payload = seed_file(client, "bridge-attachment-" + uuid.uuid4().hex)
        file_id = str(uuid.uuid4())
        content = "附件夹具采用真实文件读取。"
        (tmp_path / "资料 中文.txt").write_text(content)

        async def insert():
            async with async_session_maker() as db:
                db.add(
                    ProjectAttachment(
                        id=file_id,
                        project_id=payload["project_id"],
                        original_filename="资料 中文.txt",
                        stored_path="资料 中文.txt",
                        size_bytes=len(content.encode()),
                        content_type="text/plain",
                    )
                )
                await db.commit()

        asyncio.run(insert())
        result = client.post(
            "/api/v1/studio/turn",
            json={**payload, "file_id": file_id, "file_kind": "attachment"},
            headers=headers,
        )
        assert result.status_code == 200, result.text
        assert result.json()["source"]["text"] == content
        assert result.json()["state"]["cards"][0]["term"] == "附件夹具"
