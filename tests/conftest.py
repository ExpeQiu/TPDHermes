"""测试默认环境：避免未设置 HERMES_CHAT_API_URL 时 lifespan 拒绝启动。"""

import os

import pytest

os.environ.setdefault(
    "HERMES_CHAT_API_URL",
    "http://127.0.0.1:65535/v1/chat/completions",
)
os.environ.setdefault("WORKSHOP_EXECUTION_MODE", "direct")
os.environ.setdefault("GROWTH_SCHEDULER_ENABLED", "false")
os.environ.setdefault("KB_EMBED_WARMUP", "0")
os.environ.setdefault("KB_INGEST_WORKER_ENABLED", "false")
os.environ.setdefault("KB_RECONCILE_SCHEDULER_ENABLED", "false")
# 测试环境强制开启项目 KB 自动入库（避免本地 .env 或调试 shell 污染）
os.environ["PROJECT_KB_INGEST_ENABLED"] = "1"


@pytest.fixture(autouse=True)
def _noop_schedule_output_kb_visibility(monkeypatch):
    """approve/archive 触发的异步 KB 同步在 TestClient 下可能阻塞，测试里统一跳过。"""
    noop = lambda *args, **kwargs: None
    monkeypatch.setattr(
        "backend.services.project_kb_ingest.schedule_output_kb_visibility",
        noop,
    )
    monkeypatch.setattr("backend.routes.projects.schedule_output_kb_visibility", noop)
