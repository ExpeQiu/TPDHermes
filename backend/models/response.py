"""
统一 API 响应格式
所有接口统一返回 { code, message, data, timestamp }
"""
from datetime import datetime, timezone
from typing import Any, Generic, TypeVar
from pydantic import BaseModel

T = TypeVar("T")


class ErrorCode:
    """错误码定义"""
    SUCCESS = 0
    VALIDATION_ERROR = 1001
    NOT_FOUND = 1002
    INTERNAL_ERROR = 1003
    UNAUTHORIZED = 1004


class APIResponse(BaseModel, Generic[T]):
    """统一响应模型"""
    code: int = 0
    message: str = "success"
    data: T | None = None
    timestamp: str = ""

    def __init__(self, code: int = 0, message: str = "success", data: T | None = None, **kwargs):
        super().__init__(
            code=code,
            message=message,
            data=data,
            timestamp=datetime.now(timezone.utc).isoformat(timespec="seconds")
        )

    @classmethod
    def success(cls, data: T | None = None, message: str = "success") -> "APIResponse[T]":
        return cls(code=ErrorCode.SUCCESS, message=message, data=data)

    @classmethod
    def error(cls, code: int, message: str, data: T | None = None) -> "APIResponse[T]":
        return cls(code=code, message=message, data=data)
