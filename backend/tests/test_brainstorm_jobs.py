"""头脑风暴异步任务单测。"""
from __future__ import annotations

import asyncio

import pytest

from backend.services import brainstorm_jobs as jobs


@pytest.mark.asyncio
async def test_brainstorm_job_completes(monkeypatch: pytest.MonkeyPatch):
    async def fake_roundtable(topic: str, **kwargs):
        await asyncio.sleep(0.05)
        return {
            "run_id": "r-test",
            "mode": "roundtable",
            "coordinator": "主持人",
            "status": "completed",
            "title": "t",
            "delivery_markdown": "# ok",
            "trajectory_markdown": "",
            "warnings": [],
            "bridge": "http",
            "mock": True,
            "discussion_mode": kwargs.get("discussion_mode"),
        }

    monkeypatch.setattr(jobs, "run_roundtable", fake_roundtable)

    started = await jobs.create_brainstorm_job(
        {
            "topic": "测试议题",
            "project_id": "p1",
            "user_id": "u1",
            "pack": "tech-ip",
            "rounds": 1,
            "demo": True,
            "discussion_mode": "round_robin",
        }
    )
    assert started["job_id"]
    assert started["status"] == "queued"

    deadline = asyncio.get_event_loop().time() + 2
    final = None
    while asyncio.get_event_loop().time() < deadline:
        final = await jobs.get_brainstorm_job(started["job_id"])
        if final and final["status"] in {"completed", "failed"}:
            break
        await asyncio.sleep(0.05)

    assert final is not None
    assert final["status"] == "completed"
    assert final["result"]["run_id"] == "r-test"
    assert final["result"]["project_id"] == "p1"
