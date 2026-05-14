"""
TPDHermes ASGI 入口：统一使用 backend 包内注册的 FastAPI 应用。
启动：uvicorn main:app --reload --port 8000
"""
from backend import app

__all__ = ["app"]
