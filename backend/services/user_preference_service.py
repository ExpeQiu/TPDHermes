"""用户偏好读写（统一 User ID 跨设备同步）。"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.user_preference import UserPreference

logger = logging.getLogger("tpdx.hermes.user_preference")

PREF_KEY_UNIFIED_USER_ID = "unified_user_id"
PREF_KEY_ACTIVE_CHAT_SESSION = "active_chat_session_id"
PREF_KEY_PLATFORM_ROLE = "platform_role"


def _load_prefs(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


async def get_user_preferences(db: AsyncSession, user_id: str) -> dict[str, Any]:
    row = (
        await db.execute(select(UserPreference).where(UserPreference.user_id == user_id))
    ).scalar_one_or_none()
    if not row:
        return {}
    return _load_prefs(row.preferences_json)


async def set_user_preferences(db: AsyncSession, user_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    row = (
        await db.execute(select(UserPreference).where(UserPreference.user_id == user_id))
    ).scalar_one_or_none()
    now = datetime.now().isoformat()
    if row is None:
        merged = dict(patch)
        row = UserPreference(
            user_id=user_id,
            preferences_json=json.dumps(merged, ensure_ascii=False),
            updated_at=now,
        )
        db.add(row)
    else:
        merged = _load_prefs(row.preferences_json)
        merged.update(patch)
        row.preferences_json = json.dumps(merged, ensure_ascii=False)
        row.updated_at = now
    await db.commit()
    logger.info("user_preferences updated user_id=%s keys=%s", user_id[:24], list(patch.keys()))
    return merged


async def get_unified_user_id(db: AsyncSession, user_id: str) -> str | None:
    prefs = await get_user_preferences(db, user_id)
    raw = str(prefs.get(PREF_KEY_UNIFIED_USER_ID) or "").strip()
    return raw or None


async def set_unified_user_id(db: AsyncSession, user_id: str, unified_user_id: str) -> dict[str, Any]:
    return await set_user_preferences(
        db,
        user_id,
        {PREF_KEY_UNIFIED_USER_ID: unified_user_id.strip()},
    )


async def get_platform_role_pref(db: AsyncSession, user_id: str) -> str | None:
    prefs = await get_user_preferences(db, user_id)
    raw = str(prefs.get(PREF_KEY_PLATFORM_ROLE) or "").strip()
    return raw or None


async def set_platform_role(db: AsyncSession, user_id: str, platform_role: str) -> dict[str, Any]:
    return await set_user_preferences(
        db,
        user_id,
        {PREF_KEY_PLATFORM_ROLE: platform_role.strip()},
    )
