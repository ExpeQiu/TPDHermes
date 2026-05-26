"""反馈与学习成长性闭环回归测试。"""

import pytest
from fastapi.testclient import TestClient

from backend import app


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


def test_feedback_submit_and_query(client: TestClient):
    payload = {
        "session_id": "sess_test_001",
        "message_id": "msg_test_001",
        "run_id": None,
        "project_id": None,
        "scenario_id": "general",
        "reaction_type": "thumbs_up",
        "reason_text": "测试采纳",
        "source_excerpt": "这是一条测试回复内容。",
    }
    r = client.post("/api/v1/feedback", json=payload)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("ok") is True
    fb = body.get("feedback") or {}
    assert fb.get("adoption_level") == "full"
    assert "[feedback]" in (fb.get("memory_line") or "")

    q = client.get(
        "/api/v1/feedback",
        params={"session_id": "sess_test_001", "message_id": "msg_test_001"},
    )
    assert q.status_code == 200
    items = q.json().get("items") or []
    assert len(items) >= 1
    assert items[0]["reaction_type"] == "thumbs_up"


def test_feedback_rewrite_is_reject(client: TestClient):
    r = client.post(
        "/api/v1/feedback",
        json={
            "session_id": "sess_rewrite",
            "message_id": "msg_rewrite",
            "reaction_type": "rewrite",
            "source_excerpt": "需要重写的回复",
        },
    )
    assert r.status_code == 200
    assert r.json()["feedback"]["adoption_level"] == "reject"


def test_feedback_stats(client: TestClient):
    r = client.get("/api/v1/feedback/stats", params={"days": 7})
    assert r.status_code == 200
    data = r.json()
    assert "adoption_rate" in data
    assert "rewrite_rate" in data
    assert "learning_conversion_rate" in data
    assert "kb_miss_rate" in data


def test_learning_analyze_and_report(client: TestClient):
    client.post(
        "/api/v1/feedback",
        json={
            "session_id": "s_a",
            "message_id": "m_a1",
            "scenario_id": "tech-doc",
            "reaction_type": "thumbs_down",
            "source_excerpt": "bad1",
        },
    )
    client.post(
        "/api/v1/feedback",
        json={
            "session_id": "s_b",
            "message_id": "m_b1",
            "scenario_id": "tech-doc",
            "reaction_type": "rewrite",
            "source_excerpt": "bad2",
        },
    )
    ar = client.post("/api/v1/learning/analyze", params={"days": 14})
    assert ar.status_code == 200
    signals = ar.json().get("signals") or []
    assert isinstance(signals, list)

    wr = client.post("/api/v1/learning/reports/weekly")
    assert wr.status_code == 200
    assert wr.json().get("week_start")

    lr = client.get("/api/v1/learning/reports/latest")
    assert lr.status_code == 200
    report = lr.json().get("report")
    assert report is not None
    summary = report.get("summary") or {}
    assert "feedback_stats" in summary


def test_pending_prompts_endpoint(client: TestClient):
    r = client.get("/api/v1/feedback/pending-prompts")
    assert r.status_code == 200
    assert "items" in r.json()


def test_learning_signal_ack(client: TestClient):
    client.post(
        "/api/v1/feedback",
        json={
            "session_id": "s_ack",
            "message_id": "m_ack1",
            "scenario_id": "tech-doc",
            "reaction_type": "thumbs_down",
            "source_excerpt": "ack test",
        },
    )
    client.post(
        "/api/v1/feedback",
        json={
            "session_id": "s_ack2",
            "message_id": "m_ack2",
            "scenario_id": "tech-doc",
            "reaction_type": "rewrite",
            "source_excerpt": "ack test 2",
        },
    )
    ar = client.post("/api/v1/learning/analyze", params={"days": 14})
    assert ar.status_code == 200
    signals = ar.json().get("signals") or []
    assert signals, "expected at least one learning signal"
    sig_id = signals[0]["id"]

    ack = client.patch(f"/api/v1/learning/signals/{sig_id}", json={"status": "ack"})
    assert ack.status_code == 200, ack.text
    assert ack.json().get("ok") is True
    assert ack.json()["signal"]["status"] == "ack"

    open_items = client.get("/api/v1/learning/signals").json().get("items") or []
    assert not any(item["id"] == sig_id for item in open_items)


def test_learning_experience_index(client: TestClient):
    r = client.get("/api/v1/learning/experience", params={"limit": 30})
    assert r.status_code == 200, r.text
    body = r.json()
    assert "items" in body
    assert body.get("collection") == "public.internal_methodology.tpd_experience"
