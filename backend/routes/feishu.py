"""
飞书集成路由 (M6)

端点：
  POST /feishu/notify            - 发送文本通知
  POST /feishu/notify/card      - 发送项目完成卡片
  POST /feishu/notify/task       - 发送任务状态卡片
  POST /feishu/notify/text       - 发送纯文本
  POST /feishu/notify/post       - 发送富文本帖子
  POST /feishu/messages          - 发送原始消息
  GET  /feishu/health            - 健康检查
  POST /feishu/card/render       - 预览渲染卡片 JSON
  ─────────────────────────────────────────────────────────────
  ✅ M6-T03: OAuth 认证集成
  GET  /feishu/oauth/authorize   - 重定向到飞书授权页
  GET  /feishu/oauth/callback    - 授权回调，换 token
  GET  /feishu/oauth/userinfo    - 获取登录用户信息
  POST /feishu/oauth/refresh     - 刷新 access_token
  POST /feishu/oauth/logout      - 注销本地会话
  ─────────────────────────────────────────────────────────────
  ✅ M6-T04: 文件上传
  POST /feishu/upload/file       - 上传文件（可推送群）
  POST /feishu/upload/image      - 上传图片（可推送群）
  POST /feishu/upload/file/send  - 上传并推送文件到指定群
  🔜 M6-T05: 机器人 /hermes 命令（排期中）
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from backend.services.feishu import (
    notify,
    send_text_message,
    send_post_message,
    send_interactive_card,
    build_project_complete_card,
    build_task_card,
    notify_project_complete,
    notify_task_update,
    FEISHU_PUSH_CHAT_ID,
)
from backend.services.feishu_auth import (
    build_authorization_url,
    exchange_code_simple,
    exchange_code_for_token,
    get_user_info,
    refresh_user_token,
    create_user_session,
    get_user_session,
    FeishuUser,
)

router = APIRouter(prefix="/feishu", tags=["feishu"])


# ── Schema ──────────────────────────────────────────────────────────────────

class TextNotifyRequest(BaseModel):
    text: str
    chat_id: Optional[str] = None


class CardNotifyRequest(BaseModel):
    project_name: str
    status: str = "完成"
    summary: Optional[str] = None
    tasks: Optional[list[str]] = None
    chat_id: Optional[str] = None


class TaskNotifyRequest(BaseModel):
    title: str
    description: str
    status: str = "进行中"
    assignee: Optional[str] = None
    deadline: Optional[str] = None
    chat_id: Optional[str] = None


class RawMessageRequest(BaseModel):
    chat_id: str
    msg_type: str = "text"  # text | post
    content: str
    title: Optional[str] = None  # 仅 post 类型需要


class CardRenderRequest(BaseModel):
    card_type: str  # project_complete | task
    project_name: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    status: str = "进行中"
    summary: Optional[str] = None
    tasks: Optional[list[str]] = None
    assignee: Optional[str] = None
    deadline: Optional[str] = None


# ── 路由 ────────────────────────────────────────────────────────────────────

@router.post("/notify")
async def api_notify(req: TextNotifyRequest):
    """快捷文本通知 POST /feishu/notify"""
    result = await notify(text=req.text, chat_id=req.chat_id)
    return {"ok": True, "message_id": result.get("data", {}).get("message_id")}


@router.post("/notify/text")
async def api_send_text(req: TextNotifyRequest):
    """发送纯文本消息 POST /feishu/notify/text"""
    result = await send_text_message(content=req.text, chat_id=req.chat_id)
    return {"ok": True, "message_id": result.get("data", {}).get("message_id")}


@router.post("/notify/post")
async def api_send_post(req: RawMessageRequest):
    """发送富文本帖子消息 POST /feishu/notify/post"""
    result = await send_post_message(
        title=req.title or "通知",
        content=req.content,
        chat_id=req.chat_id,
    )
    return {"ok": True, "message_id": result.get("data", {}).get("message_id")}


@router.post("/notify/card")
async def api_notify_card(req: CardNotifyRequest):
    """发送项目完成卡片（Webhook + 卡片，M6-T01+T02）POST /feishu/notify/card"""
    result = await notify_project_complete(
        project_name=req.project_name,
        status=req.status,
        summary=req.summary,
        tasks=req.tasks,
        chat_id=req.chat_id,
    )
    return {"ok": True, "message_id": result.get("data", {}).get("message_id")}


@router.post("/notify/task")
async def api_notify_task(req: TaskNotifyRequest):
    """发送任务状态更新卡片 POST /feishu/notify/task"""
    result = await notify_task_update(
        title=req.title,
        description=req.description,
        status=req.status,
        assignee=req.assignee,
        deadline=req.deadline,
        chat_id=req.chat_id,
    )
    return {"ok": True, "message_id": result.get("data", {}).get("message_id")}


@router.post("/messages")
async def api_send_message(req: RawMessageRequest):
    """通用消息发送 POST /feishu/messages"""
    if req.msg_type == "text":
        result = await send_text_message(content=req.content, chat_id=req.chat_id)
    elif req.msg_type == "post":
        result = await send_post_message(
            title=req.title or "通知",
            content=req.content,
            chat_id=req.chat_id,
        )
    else:
        raise HTTPException(status_code=400, detail=f"不支持的 msg_type: {req.msg_type}")
    return {"ok": True, "message_id": result.get("data", {}).get("message_id")}


@router.post("/card/render")
async def api_render_card(req: CardRenderRequest):
    """预览渲染卡片 JSON（不发送）POST /feishu/card/render"""
    if req.card_type == "project_complete":
        card = build_project_complete_card(
            project_name=req.project_name or "未命名项目",
            status=req.status,
            summary=req.summary,
            tasks=req.tasks,
        )
    elif req.card_type == "task":
        card = build_task_card(
            title=req.title or "未命名任务",
            description=req.description or "",
            status=req.status,
            assignee=req.assignee,
            deadline=req.deadline,
        )
    else:
        raise HTTPException(status_code=400, detail=f"不支持的 card_type: {req.card_type}")
    return {"ok": True, "card": card}


@router.get("/health")
async def api_feishu_health():
    """飞书服务健康检查 GET /feishu/health"""
    try:
        from backend.services.feishu import get_tenant_token
        token = await get_tenant_token()
        return {"ok": True, "token_received": bool(token)}
    except Exception as e:
        raise HTTPException(status_code=503, detail=str(e))


# ═══════════════════════════════════════════════════════════════
# M6-T03: OAuth 认证集成
# ═══════════════════════════════════════════════════════════════


class OAuthCallbackRequest(BaseModel):
    code: str
    state: str
    # FastAPI 从 query 取参数，所以用 Optional


class UserInfoResponse(BaseModel):
    open_id: str
    union_id: Optional[str] = None
    name: str
    avatar_url: Optional[str] = None
    email: Optional[str] = None
    session_token: str


@router.get("/oauth/authorize")
async def oauth_authorize(state: str = ""):
    """
    重定向到飞书 OAuth 授权页。
    GET /feishu/oauth/authorize

    Query params:
        state: 可选，CSRF token 或回传上下文

    Returns:
        重定向到飞书授权页面
    """
    auth_url, code_verifier = await build_authorization_url(
        state=state or None,
        scope="contact:user.base:readonly",
    )
    from fastapi.responses import RedirectResponse
    return RedirectResponse(url=auth_url, status_code=302)


@router.get("/oauth/callback")
async def oauth_callback(
    code: str,
    state: Optional[str] = None,
):
    """
    飞书 OAuth 回调端点。
    GET /feishu/oauth/callback

    流程：
        1. 验证 state（防 CSRF）
        2. 用 code 换取 user_access_token
        3. 用 token 获取用户信息
        4. 创建本地 session，返回 session_token

    Returns:
        JSON 含 session_token，可存储到 cookie/localStorage
    """
    if not code:
        raise HTTPException(status_code=400, detail="Missing authorization code")

    # 换 token + 获取用户信息
    try:
        user = await exchange_code_simple(code)
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"OAuth failed: {str(e)}")

    # 创建本地会话
    session_token = create_user_session(user)

    return {
        "ok": True,
        "session_token": session_token,
        "user": {
            "open_id": user.open_id,
            "union_id": user.union_id,
            "name": user.name,
            "avatar_url": user.avatar_url,
            "email": user.email,
        },
        "expires_in": user.expires_in,
    }


@router.post("/oauth/refresh")
async def oauth_refresh(refresh_token: str):
    """
    刷新用户 access_token。
    POST /feishu/oauth/refresh
    """
    try:
        token_info = await refresh_user_token(refresh_token)
        return {
            "ok": True,
            "access_token": token_info.access_token,
            "expires_in": token_info.expires_in,
        }
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Token refresh failed: {str(e)}")


@router.get("/oauth/userinfo")
async def oauth_userinfo(session_token: str):
    """
    获取当前登录用户信息（需 session_token）。
    GET /feishu/oauth/userinfo?session_token=xxx
    """
    user = get_user_session(session_token)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid or expired session")
    return {
        "ok": True,
        "user": {
            "open_id": user.open_id,
            "union_id": user.union_id,
            "name": user.name,
            "avatar_url": user.avatar_url,
            "email": user.email,
        },
    }


@router.post("/oauth/logout")
async def oauth_logout(session_token: str):
    """
    注销本地会话。
    POST /feishu/oauth/logout?session_token=xxx
    """
    from backend.services.feishu_auth import _USER_SESSIONS
    if session_token in _USER_SESSIONS:
        del _USER_SESSIONS[session_token]
    return {"ok": True}


# ═══════════════════════════════════════════════════════════════
# M6-T04: 文件上传
# ═══════════════════════════════════════════════════════════════

from fastapi import UploadFile, File, Form
from typing import Annotated


class FileUploadResponse(BaseModel):
    ok: bool
    file_key: Optional[str] = None
    image_key: Optional[str] = None
    message_id: Optional[str] = None
    file_name: Optional[str] = None


# ── 文件类型映射 ─────────────────────────────────────────────────────────────

# 常见扩展名 → 飞书 file_type
_EXTENSION_TO_FILE_TYPE = {
    "pdf": "pdf",
    "doc": "doc",
    "docx": "docx",
    "xls": "xls",
    "xlsx": "xlsx",
    "ppt": "ppt",
    "pptx": "pptx",
    "txt": "txt",
    "mp4": "mp4",
    "opus": "opus",
    "amr": "amr",
    "jpg": "jpg",
    "jpeg": "jpg",
    "png": "png",
    "gif": "gif",
    "webp": "webp",
}


def _get_file_type(file_name: str) -> str:
    """从文件名推断飞书 file_type"""
    ext = file_name.rsplit(".", 1)[-1].lower() if "." in file_name else ""
    return _EXTENSION_TO_FILE_TYPE.get(ext, "txt")


@router.post("/upload/file", response_model=FileUploadResponse)
async def api_upload_file(
    file: Annotated[UploadFile, File(description="要上传的文件")],
    chat_id: Annotated[str | None, Form(description="目标群 ID，留空使用默认群")] = None,
    send_to_chat: Annotated[bool, Form(description="是否立即发送到群")] = True,
):
    """
    上传文件到飞书（可选择是否推送到群）。
    POST /feishu/upload/file

    支持的文件类型：pdf, doc, docx, xls, xlsx, ppt, pptx, txt, mp4, opus, amr
    """
    from backend.services.feishu import (
        upload_file_to_feishu,
        send_file_message,
        upload_and_send_file,
    )

    # 读取文件内容
    content = await file.read()
    file_name = file.filename or "unknown"
    file_type = _get_file_type(file_name)

    if send_to_chat:
        result = await upload_and_send_file(
            file_content=content,
            file_name=file_name,
            file_type=file_type,
            chat_id=chat_id or FEISHU_PUSH_CHAT_ID,
        )
        message_id = result.get("data", {}).get("message_id")
        return FileUploadResponse(
            ok=True,
            file_name=file_name,
            message_id=message_id,
        )
    else:
        file_key = await upload_file_to_feishu(
            file_content=content,
            file_name=file_name,
            file_type=file_type,
        )
        return FileUploadResponse(
            ok=True,
            file_key=file_key,
            file_name=file_name,
        )


@router.post("/upload/image", response_model=FileUploadResponse)
async def api_upload_image(
    image: Annotated[UploadFile, File(description="要上传的图片")],
    image_type: Annotated[
        str,
        Form(description="图片类型: message(消息图片) / avatar(头像)"),
    ] = "message",
    chat_id: Annotated[str | None, Form(description="目标群 ID，留空使用默认群")] = None,
    send_to_chat: Annotated[bool, Form(description="是否立即发送到群")] = True,
):
    """
    上传图片到飞书（可选择是否推送到群）。
    POST /feishu/upload/image

    支持的图片类型：jpg, jpeg, png, gif, webp
    """
    from backend.services.feishu import (
        upload_image_to_feishu,
        send_image_message,
        upload_and_send_image,
    )

    content = await image.read()
    file_name = image.filename or "image.jpg"

    if send_to_chat:
        result = await upload_and_send_image(
            image_content=content,
            image_type=image_type,
            chat_id=chat_id or FEISHU_PUSH_CHAT_ID,
        )
        message_id = result.get("data", {}).get("message_id")
        return FileUploadResponse(
            ok=True,
            image_key=message_id,  # 图片通过消息发送，无独立 image_key
            file_name=file_name,
            message_id=message_id,
        )
    else:
        image_key = await upload_image_to_feishu(
            image_content=content,
            image_type=image_type,
        )
        return FileUploadResponse(
            ok=True,
            image_key=image_key,
            file_name=file_name,
        )


@router.post("/upload/file/send", response_model=FileUploadResponse)
async def api_upload_and_send(
    file: Annotated[UploadFile, File(description="要上传并发送的文件")],
    chat_id: Annotated[str, Form(description="目标群 ID")],
):
    """
    上传文件并推送到指定飞书群（快捷方式）。
    POST /feishu/upload/file/send
    """
    from backend.services.feishu import upload_and_send_file

    content = await file.read()
    file_name = file.filename or "unknown"
    file_type = _get_file_type(file_name)

    result = await upload_and_send_file(
        file_content=content,
        file_name=file_name,
        file_type=file_type,
        chat_id=chat_id,
    )
    message_id = result.get("data", {}).get("message_id")
    return FileUploadResponse(
        ok=True,
        file_name=file_name,
        message_id=message_id,
    )

