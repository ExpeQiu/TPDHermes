"""
请求日志中间件
记录每个请求的 method/path/time/status，并生成 trace_id
"""
import time
import uuid
import logging
from starlette.middleware.base import BaseHTTPMiddleware
from fastapi import Request

logger = logging.getLogger("tpdx.hermes.request")


class RequestLoggerMiddleware(BaseHTTPMiddleware):
    """请求日志 + trace_id 中间件"""

    async def dispatch(self, request: Request, call_next):
        # 生成 trace_id
        trace_id = str(uuid.uuid4())[:8]
        request.state.trace_id = trace_id

        start_time = time.time()

        # 等待响应
        response = await call_next(request)

        # 记录日志
        elapsed_ms = round((time.time() - start_time) * 1000, 2)
        logger.info(
            f"[{trace_id}] {request.method} {request.url.path} "
            f"| status={response.status_code} | {elapsed_ms}ms"
        )

        # 将 trace_id 注入响应头
        response.headers["X-Trace-ID"] = trace_id

        return response
