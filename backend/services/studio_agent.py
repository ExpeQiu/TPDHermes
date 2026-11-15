"""Resolve a workbench instruction through the configured Hermes gateway."""

import json
import os
from typing import Literal, TypeVar
from urllib.parse import urlsplit
from uuid import uuid4

import httpx
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from backend.services.kernel_binding import resolve_chat_upstream


class StudioAction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: Literal["show", "extract", "gaps", "locate", "save", "unsupported"]
    card_number: int | None = Field(default=None, ge=1)
    field: Literal["definition", "principle", "parameter", "scope"] | None = None
    line_start: int | None = Field(default=None, ge=1)
    line_end: int | None = Field(default=None, ge=1)


async def choose_studio_action(message: str) -> StudioAction:
    prompt = (
        '你负责选择 V04 技术卡工作台动作，只输出 JSON {"action":"..."}。'
        "extract：用户明确要求从当前资料提取或重新生成候选，可以同时要求列出缺口。"
        "gaps：只检查已保存候选的缺口。show：查看已有工作区。"
        "locate：定位已有候选。按用户指定的序号输出 card_number（从 1 开始），字段用 definition、principle、parameter、scope。提取后定位则仍用 extract，并给出相同参数。save：仅在用户明确要求保存或修改、且明确指定卡片序号、字段和原文行号时使用，同时返回 card_number、field、line_start、line_end。单行的起止行相同。unsupported：其他请求，包括确认核对和正式交付。"
        '例如「提取后定位第2张卡的参数」输出 {"action":"extract","card_number":2,"field":"parameter"}。每次只选择一个动作。你只负责分类，TPDHermes 将在收到 JSON 后执行动作。'
        "请直接输出 JSON，不调用任何工具、MCP、技能、浏览器或项目查询。"
        f"本次分类请求标识：{uuid4().hex}。"
    )
    return await classify_workbench_instruction(message, prompt, StudioAction)


Action = TypeVar("Action", bound=BaseModel)


async def classify_workbench_instruction(
    message: str, prompt: str, schema: type[Action]
) -> Action:
    dedicated_url = os.getenv("TPCSTORE_HERMES_ROUTER_URL", "").strip()
    if dedicated_url:
        url = urlsplit(dedicated_url)
        key = os.getenv("TPCSTORE_HERMES_ROUTER_KEY", "").strip()
        if (
            url.scheme not in {"http", "https"}
            or url.hostname not in {"localhost", "127.0.0.1", "::1"}
            or url.username
            or url.password
            or url.query
            or url.fragment
            or url.path != "/v1/chat/completions"
            or not key
        ):
            raise HTTPException(503, "V04 专用 Hermes 路由配置无效")
        upstream = {"url": dedicated_url, "api_key": key}
    else:
        upstream = resolve_chat_upstream()
    if not upstream["url"]:
        raise HTTPException(503, "Hermes-agent 网关未配置")
    headers = {}
    if upstream["api_key"]:
        headers["Authorization"] = f"Bearer {upstream['api_key']}"
    try:
        async with httpx.AsyncClient(timeout=90, trust_env=False) as client:
            response = await client.post(
                upstream["url"],
                headers=headers,
                json={
                    "model": "hermes-agent",
                    "stream": False,
                    "messages": [
                        {"role": "system", "content": prompt},
                        {
                            "role": "user",
                            "content": f"仅分类以下指令，输出动作 JSON：\n{message}",
                        },
                    ],
                },
            )
            response.raise_for_status()
        choice = response.json()["choices"][0]
        if choice.get("finish_reason") == "error":
            raise HTTPException(502, "Hermes-agent 报告上游执行失败")
        content = choice["message"]["content"].strip()
        if content.startswith("```") and content.endswith("```"):
            content = content.split("\n", 1)[-1][:-3].strip()
        return schema.model_validate(json.loads(content))
    except httpx.HTTPError as exc:
        raise HTTPException(502, "Hermes-agent 请求失败") from exc
    except (
        ValueError,
        ValidationError,
        TypeError,
        KeyError,
        IndexError,
        AttributeError,
    ) as exc:
        raise HTTPException(502, "Hermes-agent 返回了无法识别的工作台动作") from exc
