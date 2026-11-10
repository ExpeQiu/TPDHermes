"""系统运行配置，以及七个工作台 CLI 的可保存开关。"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger("tpdx.hermes.system_config")

from backend.services.cli_token import accept_agent_token, verify_access_token
from backend.services.external_mcp import probe_external_mcp, resolve_external_mcp, save_external_mcp
from backend.services.geelywiki_cli_config import probe_wiki_mcp, resolve_wiki_mcp, save_wiki_mcp
from backend.services.hermes_model_config import read_hermes_model, save_hermes_model
from backend.services.kernel_binding import bind_kernel, list_kernels, save_bound_model, unbind_kernel
from backend.services.kernel_model_probe import probe_bound_model
from backend.services.runtime_config import build_runtime_config
from backend.services.studio_skill_release import public_release, save_release
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


class WikiMcpSave(BaseModel):
    url: str | None = None
    import_scope: str | None = None


class WikiMcpProbe(BaseModel):
    url: str = ""


class ExternalMcpSave(BaseModel):
    mcp_url: str = ""


class HermesModelSave(BaseModel):
    provider: str
    model: str
    base_url: str = ""
    api_key: str = ""


class StudioSkillReleaseSave(BaseModel):
    released: dict[str, bool]


class KernelBind(BaseModel):
    kernel_id: str
    root: str


@router.get("/config")
def system_config() -> dict:
    return build_runtime_config()


@router.get("/kernels")
def system_kernels() -> dict:
    return list_kernels()


@router.put("/kernels/binding")
def update_kernel_binding(body: KernelBind) -> dict:
    try:
        saved = bind_kernel(body.kernel_id, body.root)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        logger.error("kernel binding write failed err=%s", exc)
        raise HTTPException(status_code=500, detail=f"无法写入内核绑定: {exc}") from exc
    return saved


@router.put("/kernels/model")
def update_kernel_model(body: HermesModelSave) -> dict:
    try:
        return save_bound_model(
            provider=body.provider,
            model=body.model,
            base_url=body.base_url,
            api_key=body.api_key,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        logger.error("kernel model write failed err=%s", exc)
        raise HTTPException(status_code=500, detail=f"无法写入内核模型: {exc}") from exc


@router.post("/kernels/model/probe")
def probe_kernel_model(body: HermesModelSave) -> dict:
    try:
        return probe_bound_model(
            provider=body.provider,
            model=body.model,
            base_url=body.base_url,
            api_key=body.api_key,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/kernels/binding")
def delete_kernel_binding() -> dict:
    try:
        return unbind_kernel()
    except OSError as exc:
        logger.error("kernel binding delete failed err=%s", exc)
        raise HTTPException(status_code=500, detail=f"无法解除内核绑定: {exc}") from exc


@router.get("/hermes-model")
def get_hermes_model() -> dict:
    return read_hermes_model()


@router.put("/hermes-model")
def update_hermes_model(body: HermesModelSave) -> dict:
    try:
        saved = save_hermes_model(
            provider=body.provider,
            model=body.model,
            base_url=body.base_url,
            api_key=body.api_key,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        logger.error("hermes model write failed err=%s", exc)
        raise HTTPException(status_code=500, detail=f"无法写入配置文件: {exc}") from exc
    logger.info("hermes model updated provider=%s model=%s", saved["provider"], saved["model"])
    return saved


@router.get("/studio-skills")
def studio_skill_release() -> dict:
    return public_release()


@router.put("/studio-skills")
def update_studio_skill_release(body: StudioSkillReleaseSave) -> dict:
    try:
        saved = save_release(body.released)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        logger.error("studio skill release write failed err=%s", exc)
        raise HTTPException(status_code=500, detail=f"无法写入配置文件: {exc}") from exc
    return saved


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


@router.get("/wiki-mcp")
def get_wiki_mcp() -> dict:
    return resolve_wiki_mcp()


@router.put("/wiki-mcp")
def update_wiki_mcp(body: WikiMcpSave) -> dict:
    try:
        saved = save_wiki_mcp(url=body.url, import_scope=body.import_scope)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        logger.error("geelywiki mcp config write failed err=%s", exc)
        raise HTTPException(status_code=500, detail=f"无法写入配置文件: {exc}") from exc
    logger.info("geelywiki mcp config updated url_source=%s", saved["url_source"])
    return saved


@router.post("/wiki-mcp/probe")
def probe_wiki_mcp_route(body: WikiMcpProbe) -> dict:
    return probe_wiki_mcp(url=body.url)


@router.get("/external-mcp")
def get_external_mcp() -> dict:
    return resolve_external_mcp()


@router.put("/external-mcp/{provider_id}")
def update_external_mcp(provider_id: str, body: ExternalMcpSave) -> dict:
    try:
        saved = save_external_mcp(provider_id, mcp_url=body.mcp_url)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"未知三方 MCP: {provider_id}") from None
    except OSError as exc:
        logger.error("external mcp config write failed provider=%s err=%s", provider_id, exc)
        raise HTTPException(status_code=500, detail=f"无法写入配置文件: {exc}") from exc
    logger.info("external mcp updated provider=%s", provider_id)
    return saved


@router.post("/external-mcp/{provider_id}/probe")
def probe_external_mcp_route(provider_id: str, body: ExternalMcpSave) -> dict:
    try:
        return probe_external_mcp(provider_id, mcp_url=body.mcp_url)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"未知三方 MCP: {provider_id}") from None
