"""技能等资源按 owner 可见性过滤（对齐 TPD-skill-platform）。"""
from __future__ import annotations

from backend.services.user_identity import is_global_admin_user


def skill_installation_visible(owner_id: str | None, viewer_user_id: str) -> bool:
    o = (owner_id or "").strip()
    if not o:
        return True
    if is_global_admin_user(viewer_user_id):
        return True
    return o == (viewer_user_id or "").strip()


def skill_dict_visibility_fields(owner_id: str | None) -> dict[str, str]:
    o = (owner_id or "").strip()
    if not o:
        return {
            "owner_id": "",
            "owner_type": "platform",
            "visibility": "global",
        }
    return {
        "owner_id": o,
        "owner_type": "user",
        "visibility": "user",
    }
