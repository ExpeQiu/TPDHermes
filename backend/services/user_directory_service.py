"""平台注册用户目录（聚合 user_preferences / usage_events / project_members）。"""

from __future__ import annotations

import logging

from sqlalchemy import distinct, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.models.project_member import ProjectMember
from backend.models.usage_event import UsageEvent
from backend.models.user_preference import UserPreference
from backend.services.rbac import PLATFORM_ROLE_LABELS
from backend.services.user_preference_service import PREF_KEY_PLATFORM_ROLE, _load_prefs

logger = logging.getLogger("tpdx.hermes.user_directory")


def user_display_name(user_id: str) -> str:
    uid = (user_id or "").strip()
    if not uid or uid == "default":
        return "默认用户"
    if uid.startswith("feishu:"):
        tail = uid[7:]
        return f"飞书 · {tail[-6:]}" if len(tail) > 6 else f"飞书 · {tail}"
    if uid.startswith("user_"):
        return f"用户 · {uid[5:]}"
    if len(uid) > 20:
        return f"{uid[:8]}…{uid[-4:]}"
    return uid


def user_avatar_initial(user_id: str, display_name: str | None = None) -> str:
    label = (display_name or user_display_name(user_id)).strip()
    for ch in label:
        if ch.isalnum() or "\u4e00" <= ch <= "\u9fff":
            return ch.upper()
    uid = (user_id or "U").strip()
    return uid[0].upper()


async def list_registered_users(db: AsyncSession) -> list[dict[str, str | None]]:
    user_ids: set[str] = set()

    pref_rows = await db.execute(select(UserPreference.user_id))
    for row in pref_rows.all():
        uid = str(row[0] or "").strip()
        if uid:
            user_ids.add(uid)

    usage_rows = await db.execute(select(distinct(UsageEvent.user_id)))
    for row in usage_rows.all():
        uid = str(row[0] or "").strip()
        if uid and uid != "default":
            user_ids.add(uid)

    member_rows = await db.execute(select(distinct(ProjectMember.user_id)))
    for row in member_rows.all():
        uid = str(row[0] or "").strip()
        if uid:
            user_ids.add(uid)

    pref_map: dict[str, dict] = {}
    if user_ids:
        prefs = await db.execute(select(UserPreference).where(UserPreference.user_id.in_(user_ids)))
        for pref in prefs.scalars().all():
            pref_map[pref.user_id] = _load_prefs(pref.preferences_json)

    out: list[dict[str, str | None]] = []
    for uid in sorted(user_ids, key=lambda x: user_display_name(x).lower()):
        prefs = pref_map.get(uid, {})
        platform_role = str(prefs.get(PREF_KEY_PLATFORM_ROLE) or "").strip() or None
        out.append(
            {
                "user_id": uid,
                "display_name": user_display_name(uid),
                "avatar_initial": user_avatar_initial(uid),
                "platform_role": platform_role,
                "platform_role_label": PLATFORM_ROLE_LABELS.get(platform_role or "", platform_role),
            }
        )

    logger.info("user_directory listed count=%s", len(out))
    return out
