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
    direct = bool(ctx.get("direct_hermes"))
    if direct and not ctx.get("allow_write"):
        system = str(role.get("system") or "你是 Hermes。")
        system += (
            "\n用对话口吻直接回答。不要写成某个入座角色的正式文稿，也不要加文档标题。"
            "\n平台已授权执行文件动作。用户要求存档、成稿或修订时，回复末尾输出"
            " ```tphermes_file_actions```，动作为 create 或 patch，content 写完整正文。"
            "平台会执行并显示在右侧项目文件。不要写入 /opt/data/输出，不要声称平台禁止落库。"
            "纯问答不要输出该代码块。"
        )
    else:
        system = str(role.get("system") or "你是项目主笔。")
        system += (
            "\n只输出正式正文或对目标文稿的完整修订稿。"
            "不要复述用户指令，不要写讨论纪要。"
            "若要求删除原句，正文中不得保留该句。"
            "资料缺失时明确写出缺失，不要编造正文来源。"
        )
        has_document = bool(str(ctx.get("document") or "").strip())
        if ctx.get("allow_write") and not ctx.get("final_editor"):
            system += (
                "\n本轮还有后面的角色执笔。只写你负责的修改意见，不要输出整篇文稿，"
                "也不要调用 write_file。"
            )
        elif ctx.get("allow_write") and has_document:
            system += (
                "\n当前正文是已有项目文件。按用户和前面角色的意见修订这一版。"
                "回复从标题开始给出完整修订稿。平台会用它覆盖右侧同一文件。"
                "不要调用 write_file，也不要写入 /opt/data/输出。"
            )
        elif ctx.get("allow_write"):
            system += (
                "\n本轮要落成项目文件。平台会把你的回复正文写入右侧项目文件。"
                "不要调用 write_file，也不要写入 /opt/data/输出。"
                "回复从文稿标题开始，不要解释落盘路径。"
            )
        else:
            system += (
                "\n本轮没有要求改稿。纯问答不要输出文稿。"
                "若仍给出带 content 的 tphermes_file_actions create 或 patch，平台已授权并会执行。"
                "不要写入 /opt/data/输出，不要声称平台禁止落库。"
            )
    system += (
        "\n技能文件在 /opt/project-skills 和 /app/skills。读到技能后，在本回复里写出全文。"
        "\n工具失败时不要重复调用，直接根据已有信息作答。"
    )
    run_id = str(ctx.get("run_id") or "").strip()
    if run_id:
        system += (
            f"\n当前 tphermes_run_id={run_id}。调用 workshop、知识库或检索工具时必须原样传入这个值，"
            "不要使用 local-agent-run 或其他自拟 ID。"
        )
    transcript = [str(line).strip() for line in (ctx.get("transcript") or []) if str(line).strip()]
    prior = "\n".join(transcript)
    if len(prior) > 24000:
        prior = prior[-24000:]
    user = "\n\n".join(
        [
            f"模式: {ctx.get('agent_mode') or 'agent'}",
            f"写入: {'允许' if ctx.get('allow_write') else '禁止'} ({ctx.get('write_reason') or ''})",
            f"此前对话:\n{prior or '（无）'}",
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
    timeout = float(os.getenv("ROOM_WRITER_TIMEOUT_SECONDS", "300"))
    payload = {"model": model, "messages": messages, "stream": False}
    api_key = os.getenv("HERMES_CHAT_API_KEY", "").strip()
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    started = time.perf_counter()
    logger.info(
        "[co-create-room] writer request driver=hermes model=%s auth=%s",
        model,
        "yes" if api_key else "no",
    )
    try:
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            response = await client.post(url, json=payload, headers=headers)
    except httpx.TimeoutException as exc:
        logger.warning("[co-create-room] writer timeout seconds=%s err=%s", timeout, exc.__class__.__name__)
        raise RuntimeError(f"真实主笔超时：Hermes 在 {int(timeout)} 秒内没有返回") from exc
    except httpx.HTTPError as exc:
        detail = str(exc).strip() or exc.__class__.__name__
        logger.warning("[co-create-room] writer transport failed err=%s", detail)
        raise RuntimeError(f"真实主笔不可用：{detail}") from exc
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
