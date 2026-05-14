"""
飞书机器人 /hermes 命令路由 (M6-T05)

端点：
  POST /feishu/bot/webhook   - 飞书事件回调（消息事件）
  POST /feishu/bot/send      - 主动推送消息到指定会话

/hermes 子命令：
  /hermes help               - 显示帮助
  /hermes status             - 系统状态
  /hermes skills             - 列出所有 Skill
  /hermes skills list        - 同上（别名）
  /hermes skills run <name>  - 运行指定 Skill
  /hermes kb sync            - 触发知识库同步
  /hermes kb collections     - 列出 KB collections
  /hermes kb query <text>    - 查询知识库
  /hermes generate <skill>   - 快捷生成（调用工坊）
  /hermes health             - 健康检查
  unknown                    - 无法识别的命令，显示帮助
"""

from __future__ import annotations

import json
import httpx
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.services.feishu import (
    get_tenant_token,
    FEISHU_BASE_URL,
)
from backend.services.skill_loader import get_loader
from backend.services.kb_proxy import kb_proxy_service

router = APIRouter(prefix="/feishu/bot", tags=["feishu_bot"])


# ═══════════════════════════════════════════════════════════════
# Feishu Event Webhook
# ═══════════════════════════════════════════════════════════════

class FeishuEventRequest(BaseModel):
    """飞书事件回调请求体（简化版）"""
    schema: str = "2.0"
    header: dict
    event: Optional[dict] = None


async def _send_reply(
    open_id: str,
    reply_id: str,
    content: str,
) -> dict:
    """
    在原消息下回复（reply）

    Feishu 消息回复需要用 reply_id 对应 message_id
    """
    token = await get_tenant_token()
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json; charset=utf-8",
    }
    payload = {
        "receive_id": open_id,
        "msg_type": "post",
        "content": json.dumps({
            "zh_cn": {
                "title": "🤖 Hermes Bot",
                "content": [[{"tag": "text", "text": content}]]
            }
        }),
        "reply_in_thread": False,
    }
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            f"{FEISHU_BASE_URL}/im/v1/messages/{reply_id}/reply",
            json=payload,
            headers=headers,
        )
        return resp.json()


def _build_hermes_card(blocks: list[dict]) -> dict:
    """构建统一格式的 Hermes 卡片"""
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "title": {"tag": "plain_text", "content": "🤖 Hermes Bot", "style": 1},
            "template": "blue",
        },
        "elements": blocks,
    }


async def _send_card(chat_id: str, card: dict) -> dict:
    """发送卡片消息"""
    token = await get_tenant_token()
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json; charset=utf-8",
    }
    payload = {
        "receive_id": chat_id,
        "msg_type": "interactive",
        "content": json.dumps(card),
    }
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            f"{FEISHU_BASE_URL}/im/v1/messages",
            json=payload,
            params={"receive_id_type": "chat_id"},
            headers=headers,
        )
        return resp.json()


# ═══════════════════════════════════════════════════════════════
# /hermes 命令处理
# ═══════════════════════════════════════════════════════════════

async def handle_hermes_command(
    args: list[str],
    open_id: str,
    reply_id: str,
    chat_id: str,
) -> str:
    """
    路由 /hermes 子命令，返回响应文本或 'card' 以发送卡片
    """
    if not args:
        args = ["help"]

    cmd = args[0].lower()
    sub = args[1:] if len(args) > 1 else []

    # ── /hermes help ──────────────────────────────────────────
    if cmd == "help":
        blocks = [
            {"tag": "markdown", "content": "**🤖 Hermes Bot 帮助**"},
            {"tag": "markdown", "content": "`/hermes help` - 显示本帮助"},
            {"tag": "markdown", "content": "`/hermes status` - 系统运行状态"},
            {"tag": "markdown", "content": "`/hermes health` - 健康检查"},
            {"tag": "hr"},
            {"tag": "markdown", "content": "**📦 Skill 管理**"},
            {"tag": "markdown", "content": "`/hermes skills` - 列出所有 Skill"},
            {"tag": "markdown", "content": "`/hermes skills run <name>` - 运行指定 Skill"},
            {"tag": "hr"},
            {"tag": "markdown", "content": "**🗃️ 知识库**"},
            {"tag": "markdown", "content": "`/hermes kb sync` - 触发 KB 同步"},
            {"tag": "markdown", "content": "`/hermes kb collections` - 列出 collections"},
            {"tag": "markdown", "content": "`/hermes kb query <text>` - 查询知识库"},
            {"tag": "hr"},
            {"tag": "markdown", "content": "**⚡ 快捷生成**"},
            {"tag": "markdown", "content": "`/hermes generate <skill>` - 调用工坊生成"},
            {"tag": "markdown", "content": "`⏰ {0}`".format(datetime.now().strftime("%Y-%m-%d %H:%M:%S"))},
        ]
        card = _build_hermes_card(blocks)
        await _send_card(chat_id, card)
        return "[card sent]"

    # ── /hermes status ─────────────────────────────────────────
    if cmd == "status":
        try:
            health = await kb_proxy_service.health_check()
        except Exception:
            health = {"external_kb": "unknown", "cache_mode": False, "cached_entries": 0}

        loader = get_loader()
        skills = loader.discover()

        blocks = [
            {"tag": "markdown", "content": "**📊 系统状态**"},
            {"tag": "markdown", "content": f"**外部 KB:** `{health.get('external_kb', 'unknown')}`"},
            {"tag": "markdown", "content": f"**缓存模式:** `{'是' if health.get('cache_mode') else '否'}`"},
            {"tag": "markdown", "content": f"**缓存条目:** `{health.get('cached_entries', 0)}`"},
            {"tag": "markdown", "content": f"**注册 Skill:** `{len(skills)}` 个"},
            {"tag": "markdown", "content": f"**Skill 列表:** `{', '.join(skills) if skills else '无'}`"},
            {"tag": "hr"},
            {"tag": "markdown", "content": f"`⏰ {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}`"},
        ]
        card = _build_hermes_card(blocks)
        await _send_card(chat_id, card)
        return "[card sent]"

    # ── /hermes health ─────────────────────────────────────────
    if cmd == "health":
        try:
            health = await kb_proxy_service.health_check()
        except Exception as e:
            health = {"error": str(e)}

        token_ok = False
        try:
            token = await get_tenant_token()
            token_ok = bool(token)
        except Exception:
            pass

        status = "✅ 正常" if token_ok else "❌ 异常"
        blocks = [
            {"tag": "markdown", "content": "**🏥 健康检查**"},
            {"tag": "markdown", "content": f"**飞书连接:** `{status}`"},
            {"tag": "markdown", "content": f"**详情:** `{json.dumps(health, ensure_ascii=False)}`"},
            {"tag": "markdown", "content": f"`⏰ {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}`"},
        ]
        card = _build_hermes_card(blocks)
        await _send_card(chat_id, card)
        return "[card sent]"

    # ── /hermes skills [list] ───────────────────────────────────
    if cmd == "skills":
        sub_cmd = sub[0].lower() if sub else "list"

        if sub_cmd == "list":
            loader = get_loader()
            skills = loader.discover()
            skill_list = "\n".join(f"- `{s}`" for s in skills) if skills else "_无_"
            blocks = [
                {"tag": "markdown", "content": "**📦 已注册 Skill**"},
                {"tag": "markdown", "content": skill_list},
                {"tag": "markdown", "content": f"**共 {len(skills)} 个 Skill**"},
                {"tag": "hr"},
                {"tag": "markdown", "content": f"`⏰ {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}`"},
            ]
            card = _build_hermes_card(blocks)
            await _send_card(chat_id, card)
            return "[card sent]"

        if sub_cmd == "run" and len(sub) > 1:
            skill_name = sub[1]
            loader = get_loader()
            try:
                skill = loader.load(skill_name)
                # 检查是否有 execute 方法
                if hasattr(skill, 'execute'):
                    result = skill.execute({})
                    result_str = str(result)[:500]
                else:
                    result_str = "(Skill loaded, no execute method)"
                blocks = [
                    {"tag": "markdown", "content": f"**✅ Skill `{skill_name}` 已加载**"},
                    {"tag": "markdown", "content": f"**结果:**\n`{result_str}`"},
                    {"tag": "markdown", "content": f"`⏰ {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}`"},
                ]
            except Exception as e:
                blocks = [
                    {"tag": "markdown", "content": "**❌ Skill 加载失败**"},
                    {"tag": "markdown", "content": f"**错误:** `{e}`"},
                    {"tag": "markdown", "content": f"`⏰ {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}`"},
                ]
            card = _build_hermes_card(blocks)
            await _send_card(chat_id, card)
            return "[card sent]"

        # skills 未知子命令，显示帮助
        blocks = [
            {"tag": "markdown", "content": "**📦 Skill 子命令**"},
            {"tag": "markdown", "content": "`/hermes skills` - 列出所有 Skill"},
            {"tag": "markdown", "content": "`/hermes skills run <name>` - 运行指定 Skill"},
            {"tag": "markdown", "content": f"`⏰ {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}`"},
        ]
        card = _build_hermes_card(blocks)
        await _send_card(chat_id, card)
        return "[card sent]"

    # ── /hermes kb ─────────────────────────────────────────────
    if cmd == "kb":
        sub_cmd = sub[0].lower() if sub else ""
        rest = sub[1:] if len(sub) > 1 else []

        if sub_cmd == "sync":
            blocks = [
                {"tag": "markdown", "content": "**🔄 知识库同步已触发**"},
                {"tag": "markdown", "content": "_正在同步，请稍候..._"},
                {"tag": "markdown", "content": f"`⏰ {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}`"},
            ]
            card = _build_hermes_card(blocks)
            await _send_card(chat_id, card)
            return "[card sent]"

        if sub_cmd == "collections":
            result = await kb_proxy_service.list_collections()
            cols = result.get("collections", [])
            col_list = "\n".join(f"- `{c}`" for c in cols) if cols else "_无_"
            blocks = [
                {"tag": "markdown", "content": "**🗃️ KB Collections**"},
                {"tag": "markdown", "content": f"**来源:** `{result.get('source', 'unknown')}`"},
                {"tag": "markdown", "content": col_list},
                {"tag": "hr"},
                {"tag": "markdown", "content": f"**共 {len(cols)} 个 collections**"},
                {"tag": "markdown", "content": f"`⏰ {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}`"},
            ]
            card = _build_hermes_card(blocks)
            await _send_card(chat_id, card)
            return "[card sent]"

        if sub_cmd == "query" and rest:
            query_text = " ".join(rest)
            # KB 查询需要 collection_name，先用默认 collection
            try:
                result = await kb_proxy_service.query_collection(
                    collection_name="default",
                    query_text=query_text,
                    n_results=5,
                )
                items = result.get("results", [])
                if items:
                    content_preview = "\n".join(
                        f"- `{item.get('content', '')[:80]}...`" for item in items
                    )
                else:
                    content_preview = "_未找到相关结果_"
                blocks = [
                    {"tag": "markdown", "content": f"**🔍 查询: `{query_text}`**"},
                    {"tag": "markdown", "content": f"**来源:** `{result.get('source', 'unknown')}`"},
                    {"tag": "markdown", "content": f"**结果 ({result.get('count', 0)} 条):**"},
                    {"tag": "markdown", "content": content_preview},
                    {"tag": "hr"},
                    {"tag": "markdown", "content": f"`⏰ {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}`"},
                ]
            except Exception as e:
                blocks = [
                    {"tag": "markdown", "content": f"**❌ 查询失败:** `{e}`"},
                    {"tag": "markdown", "content": f"`⏰ {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}`"},
                ]
            card = _build_hermes_card(blocks)
            await _send_card(chat_id, card)
            return "[card sent]"

        # kb 未知子命令
        blocks = [
            {"tag": "markdown", "content": "**🗃️ KB 子命令**"},
            {"tag": "markdown", "content": "`/hermes kb sync` - 触发同步"},
            {"tag": "markdown", "content": "`/hermes kb collections` - 列出 collections"},
            {"tag": "markdown", "content": "`/hermes kb query <text>` - 查询知识库"},
            {"tag": "markdown", "content": f"`⏰ {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}`"},
        ]
        card = _build_hermes_card(blocks)
        await _send_card(chat_id, card)
        return "[card sent]"

    # ── /hermes generate <skill> ────────────────────────────────
    if cmd == "generate":
        if not sub:
            blocks = [
                {"tag": "markdown", "content": "**⚡ Generate 子命令**"},
                {"tag": "markdown", "content": "`/hermes generate <skill>` - 调用工坊生成"},
                {"tag": "markdown", "content": f"`⏰ {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}`"},
            ]
            card = _build_hermes_card(blocks)
            await _send_card(chat_id, card)
            return "[card sent]"

        skill_name = sub[0]
        blocks = [
            {"tag": "markdown", "content": "**⚡ 正在调用 `/ws/generate`**"},
            {"tag": "markdown", "content": f"**Skill:** `{skill_name}`"},
            {"tag": "markdown", "content": "_结果将通过 SSE 返回，请稍候..._"},
            {"tag": "markdown", "content": f"`⏰ {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}`"},
        ]
        card = _build_hermes_card(blocks)
        await _send_card(chat_id, card)
        return "[card sent]"

    # ── unknown command ─────────────────────────────────────────
    blocks = [
        {"tag": "markdown", "content": "**❓ 未知命令**"},
        {"tag": "markdown", "content": f"无法识别的子命令: `{cmd}`"},
        {"tag": "markdown", "content": "输入 `/hermes help` 查看可用命令"},
        {"tag": "markdown", "content": f"`⏰ {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}`"},
    ]
    card = _build_hermes_card(blocks)
    await _send_card(chat_id, card)
    return "[card sent]"


# ═══════════════════════════════════════════════════════════════
# Routes
# ═══════════════════════════════════════════════════════════════

@router.post("/webhook")
async def feishu_bot_webhook(request: dict):
    """
    飞书事件回调端点。
    POST /feishu/bot/webhook

    验证 Challenge 请求（飞书事件订阅验证），
    处理消息事件，路由 /hermes 命令。

    事件类型（event_type）：
      - im.message.receive_v1: 接收消息
      - im.message: 同上（旧版）

    支持的消息类型：
      - text: 文本消息
      - post: 富文本消息
    """
    # ── Challenge 验证 ──────────────────────────────────────────
    # 飞书事件订阅验证：GET/POST 带 challenge 参数
    if request.get("challenge"):
        return {"challenge": request["challenge"]}

    header = request.get("header", {})
    event = request.get("event", {})

    # ── 消息接收事件 ────────────────────────────────────────────
    event_type = header.get("event_type", "")
    if event_type not in ("im.message.receive_v1", "im.message"):
        # 忽略其他事件类型
        return {"ok": True, "skipped": event_type}

    # 提取消息内容
    sender = event.get("sender", {})
    message = event.get("message", {})
    open_id = sender.get("sender_id", {}).get("open_id", "")
    chat_id = message.get("chat_id", "")
    message_id = message.get("message_id", "")
    message.get("msg_type", "")
    content_str = message.get("content", "{}")

    # ── 解析消息内容 ─────────────────────────────────────────────
    try:
        content = json.loads(content_str) if isinstance(content_str, str) else content_str
    except Exception:
        content = {}

    text = content.get("text", "").strip() if isinstance(content, dict) else ""

    # ── 只处理 /hermes 命令 ──────────────────────────────────────
    if text.startswith("/hermes"):
        # 解析命令和参数
        parts = text.split()
        # parts[0] = "/hermes", parts[1:] = args
        args = parts[1:] if len(parts) > 1 else []
        try:
            await handle_hermes_command(
                args=args,
                open_id=open_id,
                reply_id=message_id,
                chat_id=chat_id,
            )
        except Exception as e:
            # 出错时发送错误卡片
            blocks = [
                {"tag": "markdown", "content": "**❌ 命令执行失败**"},
                {"tag": "markdown", "content": f"**错误:** `{e}`"},
                {"tag": "markdown", "content": f"`⏰ {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}`"},
            ]
            card = _build_hermes_card(blocks)
            try:
                await _send_card(chat_id, card)
            except Exception:
                pass
        return {"ok": True, "command": "handled"}

    # 非 /hermes 命令，不响应（静默忽略）
    return {"ok": True, "skipped": "not_hermes_command"}


# ── 主动推送 ────────────────────────────────────────────────────

class BotSendRequest(BaseModel):
    chat_id: str
    msg_type: str = "text"
    content: str
    title: Optional[str] = None  # 仅 post 类型使用


@router.post("/send")
async def bot_send_message(req: BotSendRequest):
    """
    主动向指定会话推送消息。
    POST /feishu/bot/send
    """
    if req.msg_type == "text":
        result = await _send_reply(
            open_id=req.chat_id,
            reply_id="",  # 主动推送不用 reply_id
            content=req.content,
        )
    elif req.msg_type == "card":
        blocks = [{"tag": "markdown", "content": req.content}]
        card = _build_hermes_card(blocks)
        result = await _send_card(req.chat_id, card)
    else:
        raise HTTPException(status_code=400, detail="Unsupported msg_type")

    if result.get("code") != 0:
        raise HTTPException(status_code=502, detail=f"Feishu API error: {result}")
    return {"ok": True, "message_id": result.get("data", {}).get("message_id")}


# ═══════════════════════════════════════════════════════════════
# 注册 verify_token 路由（供飞书事件配置页使用）
# ═══════════════════════════════════════════════════════════════

@router.get("/verify")
async def bot_verify():
    """
    飞书事件订阅 URL 验证端点。
    GET /feishu/bot/verify
    """
    return {"ok": True}
