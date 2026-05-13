"""
全局异常处理中间件
捕获所有未处理异常，返回统一格式并记录 error log
"""
import logging
import traceback
import sys
from datetime import datetime, timezone

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from pydantic import ValidationError

from backend.models.response import APIResponse, ErrorCode

logger = logging.getLogger("tpdx.hermes.exception")


class ExceptionHandlerMiddleware(BaseHTTPMiddleware):
    """全局异常处理"""

    async def dispatch(self, request: Request, call_next):
        try:
            response = await call_next(request)
            return response
        except ValidationError as exc:
            return self._handle_validation_error(request, exc)
        except HTTPNotFoundError as exc:
            return self._handle_not_found(request, exc)
        except Exception as exc:
            return self._handle_unexpected(request, exc)

    def _build_error_response(self, code: int, message: str, request: Request, detail: str = None):
        """构建统一错误响应"""
        trace_id = request.state.trace_id if hasattr(request.state, "trace_id") else "unknown"
        error_msg = detail or str(message)
        logger.error(
            f"[{trace_id}] {request.method} {request.url.path} "
            f"| code={code} | error={error_msg}"
        )
        return JSONResponse(
            status_code=200,
            content=APIResponse(code=code, message=error_msg).model_dump()
        )

    def _handle_validation_error(self, request: Request, exc: ValidationError) -> JSONResponse:
        msgs = "; ".join([e["msg"] for e in exc.errors()])
        return self._build_error_response(
            ErrorCode.VALIDATION_ERROR, msgs, request
        )

    def _handle_not_found(self, request: Request, exc: "HTTPNotFoundError") -> JSONResponse:
        return self._build_error_response(
            ErrorCode.NOT_FOUND, str(exc), request
        )

    def _handle_unexpected(self, request: Request, exc: Exception) -> JSONResponse:
        tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        trace_id = request.state.trace_id if hasattr(request.state, "trace_id") else "unknown"
        logger.error(
            f"[{trace_id}] {request.method} {request.url.path} "
            f"| INTERNAL_ERROR | {exc}\n{tb}"
        )
        return self._build_error_response(
            ErrorCode.INTERNAL_ERROR,
            "Internal server error",
            request
        )


# 自定义 404，在路由不存在时触发
class HTTPNotFoundError(Exception):
    pass


def http_not_found_handler(request: Request, exc):
    """路由不存在的统一处理"""
    return JSONResponse(
        status_code=200,
        content=APIResponse(
            code=ErrorCode.NOT_FOUND,
            message=f"Endpoint not found: {request.method} {request.url.path}"
        ).model_dump()
    )
