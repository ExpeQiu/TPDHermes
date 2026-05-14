"""
Feishu Service - 飞书集成服务 (M6)

提供:
- T01: Webhook 通知 (推送消息到飞书群)
- T02: 消息卡片渲染 (富媒体卡片)
- T03: 认证集成 (OAuth, ✅ 已实现于 feishu_auth.py)
- T04: 文件上传 ✅ (支持图片/文件上传推送群)
- T05: 机器人交互 /hermes 命令 (待实现)
"""

from __future__ import annotations

import httpx
import json
from datetime import datetime
from typing import Optional, Any

# ── 配置 ────────────────────────────────────────────────────────────────────

FEISHU_APP_ID = "cli_a93a91327978dbc6"
FEISHU_APP_SECRET = "G4QxkxWSO7zrLPrwyB3xxet00sKZZIDo"
FEISHU_PUSH_CHAT_ID = "oc_f734d856374cfe9e228a222d02f9e75f"

FEISHU_BASE_URL = "https://open.feishu.cn/open-apis"
TOKEN_CACHE: dict[str, tuple[str, float]] = {}  # token → (token_string, expire_ts)


# ── Token 管理 ───────────────────────────────────────────────────────────────

def _now() -> float:
    return datetime.now().timestamp()


async def get_tenant_token() -> str:
    """获取 tenant access token，带缓存（有效期 2 小时）"""
    cached = TOKEN_CACHE.get("tenant")
    if cached:
        token, expire_ts = cached
        if expire_ts - _now() > 60:  # 提前60s刷新
            return token

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{FEISHU_BASE_URL}/auth/v3/tenant_access_token/internal",
            json={
                "app_id": FEISHU_APP_ID,
                "app_secret": FEISHU_APP_SECRET,
            },
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") != 0:
            raise RuntimeError(f"获取 tenant token 失败: {data}")
        token = data["tenant_access_token"]
        # token 有效期 2 小时
        TOKEN_CACHE["tenant"] = (token, _now() + 7200)
        return token


# ── 核心请求方法 ─────────────────────────────────────────────────────────────

async def _feishu_post(
    path: str,
    payload: dict[str, Any],
    params: Optional[dict[str, str]] = None,
) -> dict[str, Any]:
    """通用 POST 封装，自动携带 tenant token"""
    token = await get_tenant_token()
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json; charset=utf-8",
    }
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            f"{FEISHU_BASE_URL}{path}",
            json=payload,
            params=params,
            headers=headers,
        )
        resp.raise_for_status()
        result = resp.json()
        if result.get("code") != 0:
            raise RuntimeError(f"Feishu API 错误: {result}")
        return result


# ── T01: Webhook 通知 ────────────────────────────────────────────────────────

async def send_text_message(
    content: str,
    chat_id: str = FEISHU_PUSH_CHAT_ID,
) -> dict[str, Any]:
    """
    发送文本消息到指定群

    Args:
        content: 消息内容（文本）
        chat_id: 群 ID

    Returns:
        Feishu API 响应
    """
    payload = {
        "receive_id": chat_id,
        "msg_type": "text",
        "content": json.dumps({"text": content}),
    }
    return await _feishu_post(
        "/im/v1/messages",
        payload,
        params={"receive_id_type": "chat_id"},
    )


async def send_post_message(
    title: str,
    content: str,
    chat_id: str = FEISHU_PUSH_CHAT_ID,
) -> dict[str, Any]:
    """
    发送富文本帖子消息（支持换行）

    Args:
        title: 标题
        content: 正文（支持换行符 \\n）
        chat_id: 群 ID

    Returns:
        Feishu API 响应
    """
    # Lark post 格式：[[{"tag": "text", "text": "..."}]]
    paragraphs = []
    for line in content.split("\n"):
        if line.strip():
            paragraphs.append([{"tag": "text", "text": line}])
        else:
            paragraphs.append([{"tag": "br"}])

    post_content = {
        "zh_cn": {
            "title": title,
            "content": paragraphs,
        }
    }
    payload = {
        "receive_id": chat_id,
        "msg_type": "post",
        "content": json.dumps(post_content),
    }
    return await _feishu_post(
        "/im/v1/messages",
        payload,
        params={"receive_id_type": "chat_id"},
    )


async def notify(
    text: str,
    chat_id: str = FEISHU_PUSH_CHAT_ID,
) -> dict[str, Any]:
    """
    快捷通知接口，等同于 send_text_message。
    生成完成后调用此方法推送到飞书群。
    """
    return await send_text_message(content=text, chat_id=chat_id)


# ── T02: 消息卡片渲染 ────────────────────────────────────────────────────────

def build_project_complete_card(
    project_name: str,
    status: str,
    summary: Optional[str] = None,
    tasks: Optional[list[str]] = None,
) -> dict[str, Any]:
    """
    构建项目完成卡片（可传入 send_interactive_card 使用）

    Args:
        project_name: 项目名称
        status: 完成状态
        summary: 摘要说明
        tasks: 任务列表

    Returns:
        卡片 element 数组，可直接作为 card content
    """
    elements = []

    # 状态标签
    elements.append(
        {
            "tag": "markdown",
            "content": f"**✅ 项目已完成** · `{status}`",
        }
    )

    # 项目名称
    elements.append(
        {
            "tag": "markdown",
            "content": f"**📦 项目名称：** {project_name}",
        }
    )

    # 摘要
    if summary:
        elements.append(
            {
                "tag": "markdown",
                "content": f"**📋 摘要：**\n{summary}",
            }
        )

    # 任务列表
    if tasks:
        task_md = "\n".join(f"- {t}" for t in tasks)
        elements.append(
            {
                "tag": "markdown",
                "content": f"**📌 完成内容：**\n{task_md}",
            }
        )

    # 时间戳
    elements.append(
        {
            "tag": "markdown",
            "content": f"⏰ {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        }
    )

    # 底部分隔
    elements.append({"tag": "hr"})

    card = {
        "config": {"wide_screen_mode": True},
        "header": {
            "title": {"tag": "plain_text", "content": "🚀 TPDHermes 通知", "style": 1},
            "template": "purple",
        },
        "elements": elements,
    }
    return card


def build_task_card(
    title: str,
    description: str,
    status: str = "进行中",
    assignee: Optional[str] = None,
    deadline: Optional[str] = None,
) -> dict[str, Any]:
    """
    构建任务状态卡片
    """
    elements = [
        {
            "tag": "markdown",
            "content": f"**{title}**",
        },
        {
            "tag": "markdown",
            "content": f"**状态：** `{status}`",
        },
        {
            "tag": "markdown",
            "content": f"**描述：**\n{description}",
        },
    ]
    if assignee:
        elements.append(
            {"tag": "markdown", "content": f"**负责人：** {assignee}"}
        )
    if deadline:
        elements.append(
            {"tag": "markdown", "content": f"**截止：** {deadline}"}
        )
    elements.append(
        {"tag": "markdown", "content": f"⏰ {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"}
    )
    elements.append({"tag": "hr"})

    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "title": {"tag": "plain_text", "content": f"📋 {title}", "style": 1},
            "template": "blue",
        },
        "elements": elements,
    }


async def send_interactive_card(
    card: dict[str, Any],
    chat_id: str = FEISHU_PUSH_CHAT_ID,
) -> dict[str, Any]:
    """
    发送交互卡片消息

    Args:
        card: 卡片 JSON 对象（由 build_*_card 函数构建）
        chat_id: 群 ID

    Returns:
        Feishu API 响应
    """
    payload = {
        "receive_id": chat_id,
        "msg_type": "interactive",
        "content": json.dumps(card),
    }
    return await _feishu_post(
        "/im/v1/messages",
        payload,
        params={"receive_id_type": "chat_id"},
    )


# ── 组合快捷方法 ─────────────────────────────────────────────────────────────

async def notify_project_complete(
    project_name: str,
    status: str = "完成",
    summary: Optional[str] = None,
    tasks: Optional[list[str]] = None,
) -> dict[str, Any]:
    """
    生成完成后推送到飞书群（使用消息卡片）
    """
    card = build_project_complete_card(
        project_name=project_name,
        status=status,
        summary=summary,
        tasks=tasks,
    )
    return await send_interactive_card(card)


async def notify_task_update(
    title: str,
    description: str,
    status: str = "进行中",
    assignee: Optional[str] = None,
    deadline: Optional[str] = None,
) -> dict[str, Any]:
    """任务状态更新通知"""
    card = build_task_card(
        title=title,
        description=description,
        status=status,
        assignee=assignee,
        deadline=deadline,
    )
    return await send_interactive_card(card)


# ═══════════════════════════════════════════════════════════════
# M6-T04: 文件上传
# ═══════════════════════════════════════════════════════════════

async def upload_file_to_feishu(
    file_content: bytes,
    file_name: str,
    file_type: str,
) -> str:
    """
    上传文件到飞书，获取 file_key。

    Args:
        file_content: 文件二进制内容
        file_name: 文件名（含扩展名）
        file_type: 飞书文件类型标识
            - opus/amr: 音频
            - mp4: 视频
            - pdf/doc/docx/xls/xlsx/ppt/pptx/txt: 文档
            - jpg/jpeg/png/gif/webp: 图片

    Returns:
        file_key (str)

    Ref: POST /im/v1/files
    """
    import mimetypes
    from io import BytesIO

    token = await get_tenant_token()
    headers = {"Authorization": f"Bearer {token}"}

    mime_type = mimetypes.guess_type(file_name)[0] or "application/octet-stream"

    form = {
        "file_name": (None, file_name, "text/plain"),
        "file_type": (None, file_type, "text/plain"),
    }
    files = {
        "file": (file_name, BytesIO(file_content), mime_type),
    }

    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            f"{FEISHU_BASE_URL}/im/v1/files",
            headers=headers,
            data=form,
            files=files,
        )
        resp.raise_for_status()
        result = resp.json()
        if result.get("code") != 0:
            raise RuntimeError(f"飞书文件上传失败: {result}")
        return result["data"]["file_key"]


async def upload_image_to_feishu(
    image_content: bytes,
    image_type: str = "message",
) -> str:
    """
    上传图片到飞书，获取 image_key。

    Args:
        image_content: 图片二进制内容
        image_type: 图片类型（message 消息图片 / avatar 头像）

    Returns:
        image_key (str)

    Ref: POST /im/v1/images
    """
    from io import BytesIO

    token = await get_tenant_token()
    headers = {"Authorization": f"Bearer {token}"}

    mime_type = "image/jpeg"  # 默认为 jpeg

    form = {"image_type": (None, image_type, "text/plain")}
    files = {"image": ("image.jpg", BytesIO(image_content), mime_type)}

    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            f"{FEISHU_BASE_URL}/im/v1/images",
            headers=headers,
            data=form,
            files=files,
        )
        resp.raise_for_status()
        result = resp.json()
        if result.get("code") != 0:
            raise RuntimeError(f"飞书图片上传失败: {result}")
        return result["data"]["image_key"]


async def send_file_message(
    file_key: str,
    file_name: str,
    chat_id: str = FEISHU_PUSH_CHAT_ID,
) -> dict[str, Any]:
    """
    发送文件消息（先上传文件获取 key，再发送消息）。

    Args:
        file_key: 飞书文件 key（由 upload_file_to_feishu 获取）
        file_name: 文件名（客户端显示用）
        chat_id: 群 ID

    Returns:
        Feishu API 响应

    Ref: POST /im/v1/messages (msg_type=file)
    """
    payload = {
        "receive_id": chat_id,
        "msg_type": "file",
        "content": json.dumps({"file_key": file_key, "file_name": file_name}),
    }
    return await _feishu_post(
        "/im/v1/messages",
        payload,
        params={"receive_id_type": "chat_id"},
    )


async def send_image_message(
    image_key: str,
    chat_id: str = FEISHU_PUSH_CHAT_ID,
) -> dict[str, Any]:
    """
    发送图片消息（先上传图片获取 key，再发送消息）。

    Args:
        image_key: 飞书图片 key（由 upload_image_to_feishu 获取）
        chat_id: 群 ID

    Returns:
        Feishu API 响应

    Ref: POST /im/v1/messages (msg_type=image)
    """
    payload = {
        "receive_id": chat_id,
        "msg_type": "image",
        "content": json.dumps({"image_key": image_key}),
    }
    return await _feishu_post(
        "/im/v1/messages",
        payload,
        params={"receive_id_type": "chat_id"},
    )


# ── 组合快捷方法 ──────────────────────────────────────────────────────────────

async def upload_and_send_file(
    file_content: bytes,
    file_name: str,
    file_type: str,
    chat_id: str = FEISHU_PUSH_CHAT_ID,
) -> dict[str, Any]:
    """
    一步到位：上传文件并发送到飞书群。

    Args:
        file_content: 文件二进制内容
        file_name: 文件名（含扩展名）
        file_type: 飞书文件类型标识
        chat_id: 群 ID

    Returns:
        Feishu API 响应
    """
    file_key = await upload_file_to_feishu(file_content, file_name, file_type)
    return await send_file_message(file_key, file_name, chat_id)


async def upload_and_send_image(
    image_content: bytes,
    image_type: str = "message",
    chat_id: str = FEISHU_PUSH_CHAT_ID,
) -> dict[str, Any]:
    """
    一步到位：上传图片并发送到飞书群。

    Args:
        image_content: 图片二进制内容
        image_type: 图片类型
        chat_id: 群 ID

    Returns:
        Feishu API 响应
    """
    image_key = await upload_image_to_feishu(image_content, image_type)
    return await send_image_message(image_key, chat_id)

