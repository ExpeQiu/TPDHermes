"""
TPDHermes FastAPI Application
企业级功能增强版：
- 统一 API 响应格式
- 全局异常处理
- 请求日志中间件
- 健康检查增强
- API 版本控制 (/api/v1/)
- CORS 可配置
"""
import asyncio
import os
import logging
from contextlib import asynccontextmanager

from backend.env_local import load_project_env

load_project_env()

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute

from backend.middleware import ExceptionHandlerMiddleware, RequestLoggerMiddleware
from backend.middleware.exception_handler import http_not_found_handler
from backend.models.response import APIResponse
from backend.db import engine, Base
from backend.db.sqlite_migrate import run_sqlite_migrations
from backend.env_policy import allow_missing_chat_upstream

# ── 日志配置 ──────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(name)s | %(levelname)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("tpdx.hermes")

# ── 全局 CORS origins（可从环境变量配置）─────────────────────
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ALLOWED_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000,http://localhost:8080",
    ).split(",")
    if origin.strip()
]


# ── 启动配置校验 ──────────────────────────────────────────
def _validate_deployment_config() -> None:
    """启动时校验 HERMES_CHAT_API_URL；本地 SQLite 或显式 dev 时可缺省，详见 allow_missing_chat_upstream。"""
    hermes_url = os.getenv("HERMES_CHAT_API_URL", "").strip()
    if not hermes_url:
        if allow_missing_chat_upstream():
            logger.warning(
                "HERMES_CHAT_API_URL not set — 聊天上游将不可用；"
                "生产环境请配置该变量并将 APP_ENV=production（或 PostgreSQL 等非 SQLite 库时请配置上游）"
            )
            return
        raise RuntimeError(
            "HERMES_CHAT_API_URL is not set. "
            "Production deployment requires this environment variable. "
            "Example: HERMES_CHAT_API_URL=https://your-hermes-agent:8642/v1/chat/completions. "
            "本地默认 SQLite 可免配置；非 SQLite 时请配置上游，或 APP_ENV=development / ALLOW_MISSING_HERMES_UPSTREAM=1"
        )
    logger.info("HERMES_CHAT_API_URL validated: %s", hermes_url)


# ── 数据库初始化 ───────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    """启动时校验配置并创建表"""
    _validate_deployment_config()
    logger.info("Creating database tables...")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(run_sqlite_migrations)
    logger.info("Database ready.")
    from backend.services.kb_embedding import (
        embed_warmup_blocking_enabled,
        warmup_embed_model,
    )

    if embed_warmup_blocking_enabled():
        logger.info("KB embedding warmup mode=blocking")
        await warmup_embed_model()
    else:
        logger.info("KB embedding warmup mode=background")
        asyncio.create_task(warmup_embed_model())
    from backend.services.growth_scheduler import growth_scheduler
    from backend.services.kb_ingest_worker import kb_ingest_worker
    from backend.services.kb_reconcile_scheduler import kb_reconcile_scheduler

    await growth_scheduler.start()
    await kb_ingest_worker.start()
    await kb_reconcile_scheduler.start()
    yield
    await kb_reconcile_scheduler.stop()
    await kb_ingest_worker.stop()
    await growth_scheduler.stop()
    logger.info("Shutting down...")


# ── FastAPI 实例 ───────────────────────────────────────────
app = FastAPI(
    title="TPDHermes API",
    version="0.1.0",
    lifespan=lifespan,
)

# ── 中间件注册顺序（倒序执行）────────────────────────────────
# 1. CORS（最外层）
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# 2. 请求日志（注入 trace_id）
app.add_middleware(RequestLoggerMiddleware)
# 3. 全局异常处理
app.add_middleware(ExceptionHandlerMiddleware)


# ── 全局 404 处理 ──────────────────────────────────────────
app.add_exception_handler(RequestValidationError, http_not_found_handler)


# ── API 版本控制：/api/v1/ ────────────────────────────────
API_V1_PREFIX = "/api/v1"


def include_router_with_version(router, strip_prefix: str = "", **kwargs):
    """
    将路由注册到 /api/v1/{strip_prefix}/
    先把 router 已有 prefix 里的 strip_prefix 剥掉，再套上 /api/v1/{strip_prefix}/
    """
    if strip_prefix:
        def _remap(r: APIRoute):
            if r.path.startswith(strip_prefix):
                r.path = r.path[len(strip_prefix):]
        for r in router.routes:
            if isinstance(r, APIRoute):
                _remap(r)
        app.include_router(router, prefix=f"{API_V1_PREFIX}{strip_prefix}", **kwargs)
    else:
        app.include_router(router, prefix=API_V1_PREFIX, **kwargs)


# ── 注册路由（所有路由自动加 /api/v1/ 前缀）──────────────────
# 延迟导入避免循环依赖
from backend.routes import projects_router
from backend.routes.kb import router as kb_router
from backend.routes.kb_ingest import router as kb_ingest_router
from backend.routes.kb_policies import router as kb_policies_router
from backend.routes.kb_sse import router as kb_sse_router
from backend.routes.kg import router as kg_router
from backend.routes.workshop import router as workshop_router
from backend.routes.skills_store import router as skills_store_router
from backend.routes.chat import router as chat_router
from backend.routes.chat_sessions import router as chat_sessions_router
from backend.routes.feishu import router as feishu_router
from backend.routes.feishu_bot import router as feishu_bot_router
from backend.routes.tasks import router as tasks_router, runs_router as runs_router
from backend.routes.scenarios import router as scenarios_router
from backend.routes.templates import router as templates_router
from backend.routes.me import router as me_router
from backend.routes.mcp import router as mcp_router
from backend.routes.metrics import router as metrics_router
from backend.routes.feedback import router as feedback_router, learning_router

include_router_with_version(me_router)
include_router_with_version(mcp_router, strip_prefix="/mcp")
include_router_with_version(projects_router, strip_prefix="/projects")
include_router_with_version(kb_router,       strip_prefix="/kb")
include_router_with_version(kb_ingest_router, strip_prefix="/kb")
include_router_with_version(kb_policies_router, strip_prefix="/kb")
include_router_with_version(kb_sse_router,   strip_prefix="/kb")
include_router_with_version(kg_router,         strip_prefix="/kg")
include_router_with_version(workshop_router, strip_prefix="/ws")
include_router_with_version(skills_store_router, strip_prefix="/skills")
include_router_with_version(chat_router,     strip_prefix="/chat")
include_router_with_version(chat_sessions_router, strip_prefix="/chat")
include_router_with_version(tasks_router,    strip_prefix="/tasks")
include_router_with_version(runs_router,     strip_prefix="/runs")
include_router_with_version(scenarios_router, strip_prefix="/scenarios")
include_router_with_version(templates_router, strip_prefix="/templates")
include_router_with_version(feishu_router,   strip_prefix="/feishu")
include_router_with_version(feishu_bot_router, strip_prefix="/feishu/bot")
include_router_with_version(metrics_router, strip_prefix="/metrics")
include_router_with_version(feedback_router, strip_prefix="/feedback")
include_router_with_version(learning_router, strip_prefix="/learning")


# ── 根路径 & 健康检查 ───────────────────────────────────────
@app.get("/")
async def root():
    return APIResponse.success(data={"service": "TPDHermes API", "status": "running"})


@app.get("/health")
async def health():
    """
    增强版健康检查
    返回：服务状态 | 数据库连接 | 版本号 | 依赖服务状态
    """
    import httpx

    checks = {"database": "unknown", "feishu_api": "unknown"}

    # 数据库连接检查
    try:
        from sqlalchemy import text

        from backend.db import get_db

        async for db in get_db():
            await db.execute(text("SELECT 1"))
            checks["database"] = "ok"
            break
    except Exception as e:
        checks["database"] = f"error: {e}"

    # 飞书 API 连通性（如果配置了 App ID；官方为 POST JSON）
    app_id = os.getenv("FEISHU_APP_ID")
    if app_id:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.post(
                    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
                    json={
                        "app_id": app_id,
                        "app_secret": os.getenv("FEISHU_APP_SECRET", ""),
                    },
                )
                checks["feishu_api"] = "ok" if resp.status_code == 200 else f"status={resp.status_code}"
        except Exception as e:
            checks["feishu_api"] = f"error: {e}"
    else:
        checks["feishu_api"] = "skipped"

    db_ok = checks["database"] == "ok"
    feishu_ok = checks["feishu_api"] in ("ok", "skipped")
    overall = "healthy" if db_ok and feishu_ok else "degraded"

    return APIResponse.success(data={
        "status": overall,
        "version": "0.1.0",
        "checks": checks,
    })
