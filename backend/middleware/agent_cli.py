"""其他 Agent 以 CLI 客户端访问时，必须携带已配置的接入 Token。"""

from __future__ import annotations

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from backend.services.cli_token import AGENT_CLIENT_HEADER, AGENT_TOKEN_HEADER, authorize_cli_request


class AgentCliAuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        client = (request.headers.get(AGENT_CLIENT_HEADER) or "").strip().lower()
        if client != "cli":
            return await call_next(request)
        checked = authorize_cli_request(request.headers.get(AGENT_TOKEN_HEADER))
        if not checked["ok"]:
            return JSONResponse(status_code=401, content={"detail": checked["reason"]})
        return await call_next(request)
