"""系统运行配置，以及七个工作台 CLI 的可保存开关。"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.services.cli_token import accept_agent_token, verify_access_token
from backend.services.runtime_config import build_runtime_config
from tpdhermes.capabilities import public_config, resolve_token, save_document

router = APIRouter(prefix="/system", tags=["system"])


class CliModulePatch(BaseModel):
    enabled: bool | None = None
    demo: bool | None = None
    defaults: dict[str, str] | None = None
    actions: dict[str, bool] | None = None


class CliConfigPatch(BaseModel):
    api_base: str | None = None
    user_id: str | None = None
    token: str | None = None
    modules: dict[str, CliModulePatch] | None = None


class CliTokenVerifyIn(BaseModel):
    token: str | None = None


@router.get("/config")
def system_config() -> dict:
    return build_runtime_config()


@router.get("/cli")
def cli_capabilities() -> dict:
    return public_config()


@router.put("/cli")
def update_cli_capabilities(body: CliConfigPatch) -> dict:
    patch = body.model_dump(exclude_unset=True)
    modules = patch.get("modules")
    if isinstance(modules, dict):
        patch["modules"] = {
            key: {name: value for name, value in row.items() if value is not None or name == "demo"}
            for key, row in modules.items()
        }
    if "token" in patch and isinstance(patch["token"], str) and patch["token"].strip():
        checked = accept_agent_token(patch["token"])
        if not checked["ok"]:
            raise HTTPException(status_code=400, detail=checked["reason"] or "Token 校验失败")
    try:
        save_document(patch)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return public_config()


@router.post("/cli/token/verify")
def verify_cli_token(body: CliTokenVerifyIn) -> dict:
    token = body.token if body.token is not None else resolve_token()
    return verify_access_token(token)
