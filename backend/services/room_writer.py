"""房间主笔：显式 Mock 或 Hermes 上游。上游失败不回落到 Mock。"""

from __future__ import annotations

import logging
import os
import time
from typing import Any

import httpx

from backend.services.room_contract import writer_driver_name

logger = logging.getLogger("tpdx.hermes.co_create_room")


def build_writer_messages(role: dict[str, Any], ctx: dict[str, Any]) -> list[dict[str, str]]:
    materials = ctx.get("materials") or []
    blocks: list[str] = []
    for item in materials:
        if not isinstance(item, dict):
            continue
        blocks.append(
            "\n".join(
                [
                    f"[{item.get('purpose')}] id={item.get('file_id')} version={item.get('version')} "
                    f"truncated={'yes' if item.get('truncated') else 'no'}",
                    str(item.get("excerpt") or ""),
                ]
            )
        )
    target = ctx.get("target") if isinstance(ctx.get("target"), dict) else {}
    system = str(role.get("system") or "你是项目主笔。")
    system += (
        "\n只输出正式正文或对目标文稿的完整修订稿。"
        "不要复述用户指令，不要写讨论纪要。"
        "若要求删除原句，正文中不得保留该句。"
        "资料缺失时明确写出缺失，不要编造正文来源。"
    )
    if not ctx.get("allow_write"):
        system += "\n当前运行合同不允许写文件。只回答问题，不要交付可落稿正文。"
    user = "\n\n".join(
        [
            f"模式: {ctx.get('agent_mode') or 'agent'}",
            f"写入: {'允许' if ctx.get('allow_write') else '禁止'} ({ctx.get('write_reason') or ''})",
            f"用户发言:\n{ctx.get('human_text') or ''}",
            f"目标文件: {target.get('file_id') or '新文档'} 版本 {target.get('version') or ''}",
            f"当前正文:\n{ctx.get('document') or ''}",
            "资料:\n" + ("\n\n".join(blocks) if blocks else "（无）"),
        ]
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


async def request_writer_completion(messages: list[dict[str, str]]) -> str:
    url = os.getenv("HERMES_CHAT_API_URL", "").strip()
    if not url:
        raise RuntimeError("真实主笔不可用：未配置 HERMES_CHAT_API_URL")
    model = os.getenv("HERMES_CHAT_MODEL", "").strip() or "hermes"
    timeout = float(os.getenv("ROOM_WRITER_TIMEOUT_SECONDS", "60"))
    payload = {"model": model, "messages": messages, "stream": False}
    started = time.perf_counter()
    logger.info("[co-create-room] writer request driver=hermes model=%s", model)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(url, json=payload)
    except httpx.HTTPError as exc:
        logger.warning("[co-create-room] writer transport failed err=%s", exc)
        raise RuntimeError(f"真实主笔不可用：{exc}") from exc
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    if response.status_code >= 400:
        logger.warning(
            "[co-create-room] writer upstream status=%s elapsed_ms=%s",
            response.status_code,
            elapsed_ms,
        )
        raise RuntimeError(f"真实主笔失败：HTTP {response.status_code}")
    data = response.json()
    choices = data.get("choices") if isinstance(data, dict) else None
    content = ""
    if isinstance(choices, list) and choices:
        message = choices[0].get("message") if isinstance(choices[0], dict) else None
        if isinstance(message, dict):
            content = str(message.get("content") or "")
    if not content.strip():
        raise RuntimeError("真实主笔返回空正文")
    usage = data.get("usage") if isinstance(data, dict) else None
    logger.info(
        "[co-create-room] writer response elapsed_ms=%s usage=%s chars=%s",
        elapsed_ms,
        usage,
        len(content),
    )
    return content.strip()


async def complete_with_hermes(role: dict[str, Any], ctx: dict[str, Any]) -> str:
    driver = writer_driver_name()
    if driver != "hermes":
        raise RuntimeError(f"当前驱动不是 hermes：{driver}")
    messages = build_writer_messages(role, ctx)
    return await request_writer_completion(messages)
