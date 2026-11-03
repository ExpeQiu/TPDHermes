"""项目共创群聊 API。"""

from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.db import get_db
from backend.services.project_room_service import (
    create_room,
    enqueue_human_message,
    get_room,
    list_messages,
    list_rooms,
    schedule_room_drain,
)
from backend.services.user_identity import get_effective_user_id

router = APIRouter(prefix="/projects", tags=["co-create-rooms"])


class RoomCreateBody(BaseModel):
    title: str = "共创对话"
    role_ids: list[str] = Field(default_factory=list)
    writer_role_id: str = ""


class MessageCreateBody(BaseModel):
    content: str
    mention_role_ids: list[str] = Field(default_factory=list)
    mention_user_ids: list[str] = Field(default_factory=list)
    mention_file_ids: list[str] = Field(default_factory=list)


@router.get("/{project_id}/rooms")
async def api_list_rooms(
    project_id: str,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_effective_user_id),
):
    items = await list_rooms(db, project_id=project_id, user_id=user_id)
    return {"items": items}


@router.post("/{project_id}/rooms")
async def api_create_room(
    project_id: str,
    body: RoomCreateBody,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_effective_user_id),
):
    return await create_room(
        db,
        project_id=project_id,
        user_id=user_id,
        title=body.title,
        role_ids=body.role_ids,
        writer_role_id=body.writer_role_id,
    )


@router.get("/{project_id}/rooms/{room_id}")
async def api_get_room(
    project_id: str,
    room_id: str,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_effective_user_id),
):
    return await get_room(db, project_id=project_id, room_id=room_id, user_id=user_id)


@router.get("/{project_id}/rooms/{room_id}/messages")
async def api_list_messages(
    project_id: str,
    room_id: str,
    after: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_effective_user_id),
):
    return await list_messages(
        db,
        project_id=project_id,
        room_id=room_id,
        user_id=user_id,
        after_seq=after,
    )


@router.post("/{project_id}/rooms/{room_id}/messages")
async def api_post_message(
    project_id: str,
    room_id: str,
    body: MessageCreateBody,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_effective_user_id),
):
    message = await enqueue_human_message(
        db,
        project_id=project_id,
        room_id=room_id,
        user_id=user_id,
        content=body.content,
        mention_role_ids=body.mention_role_ids,
        mention_user_ids=body.mention_user_ids,
        mention_file_ids=body.mention_file_ids,
    )
    schedule_room_drain(background_tasks, room_id)
    return message
