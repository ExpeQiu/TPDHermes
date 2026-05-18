"""
运行时环境策略：与 lifespan 一致，供 chat 等路由判断是否允许未配置聊天上游。
"""

from __future__ import annotations

import os


def allow_missing_chat_upstream() -> bool:
    """是否与启动阶段一致：本地/dev/sqlite 等场景可暂不配置 HERMES_CHAT_API_URL。"""
    if os.getenv("ALLOW_MISSING_HERMES_UPSTREAM", "").strip().lower() in ("1", "true", "yes"):
        return True
    env = (os.getenv("APP_ENV") or os.getenv("ENVIRONMENT") or os.getenv("ENV") or "").strip().lower()
    if env in ("production", "prod"):
        return False
    if env in ("development", "dev", "local", "staging", "test"):
        return True
    db = (os.getenv("DATABASE_URL") or "sqlite+aiosqlite:///./tphermes.db").lower()
    if "sqlite" in db:
        return True
    return False
