"""工坊技能可见性：上传技能仅本人可调用。"""

from __future__ import annotations

import io
import shutil
import uuid
import zipfile

import pytest
from fastapi.testclient import TestClient

from backend import app
from backend.db import async_session_maker
from backend.services.run_log_service import create_run
from backend.services.skill_loader import get_loader
from backend.services.skill_version import SkillVersionService
from backend.tools.workshop_tools import workshop_generate, workshop_list_skills


def _build_skill_zip(name: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(
            f"{name}/__init__.py",
            f"""from backend.services.skill_loader import Skill

class UploadedSkill(Skill):
    @property
    def name(self):
        return "{name}"

    def generate(self, context):
        return {{"from": "{name}", "ok": True}}
""",
        )
    return buf.getvalue()


def _cleanup_skill(name: str) -> None:
    loader = get_loader()
    skill_dir = loader.skills_root / name
    ver_dir = SkillVersionService.VERSION_ROOT / name
    if skill_dir.exists():
        shutil.rmtree(skill_dir, ignore_errors=True)
    if ver_dir.exists():
        shutil.rmtree(ver_dir, ignore_errors=True)
    loader._cache.pop(name, None)


@pytest.mark.asyncio
async def test_workshop_generate_blocks_foreign_uploaded_skill_by_run_user():
    skill_name = f"ws_upload_{uuid.uuid4().hex[:8]}"
    owner_id = "ws_owner_user"
    foreign_id = "ws_foreign_user"
    _cleanup_skill(skill_name)

    try:
        with TestClient(app) as client:
            uploaded = client.post(
                "/api/v1/skills/upload",
                headers={"X-User-ID": owner_id},
                files={
                    "file": (
                        f"{skill_name}.zip",
                        _build_skill_zip(skill_name),
                        "application/zip",
                    )
                },
            )
            assert uploaded.status_code == 200, uploaded.text

            owner_run_id = str(uuid.uuid4())
            foreign_run_id = str(uuid.uuid4())
            async with async_session_maker() as db:
                await create_run(
                    db,
                    run_id=owner_run_id,
                    project_id=None,
                    entrypoint="workshop",
                    user_id=owner_id,
                    request_json="{}",
                    snapshot_json="{}",
                )
                await create_run(
                    db,
                    run_id=foreign_run_id,
                    project_id=None,
                    entrypoint="workshop",
                    user_id=foreign_id,
                    request_json="{}",
                    snapshot_json="{}",
                )

            ok = await workshop_generate(skill_name, {"tphermes_run_id": owner_run_id})
            denied = await workshop_generate(skill_name, {"tphermes_run_id": foreign_run_id})

            assert ok.get("success") is True
            assert denied.get("success") is False
            assert "not accessible" in str(denied.get("error") or "")
    finally:
        with TestClient(app) as client:
            client.delete(f"/api/v1/skills/{skill_name}", headers={"X-User-ID": owner_id})
        _cleanup_skill(skill_name)


@pytest.mark.asyncio
async def test_workshop_list_skills_filters_uploaded_owner():
    skill_name = f"ws_upload_{uuid.uuid4().hex[:8]}"
    owner_id = "ws_owner_user2"
    other_id = "ws_other_user2"
    _cleanup_skill(skill_name)

    try:
        with TestClient(app) as client:
            uploaded = client.post(
                "/api/v1/skills/upload",
                headers={"X-User-ID": owner_id},
                files={
                    "file": (
                        f"{skill_name}.zip",
                        _build_skill_zip(skill_name),
                        "application/zip",
                    )
                },
            )
            assert uploaded.status_code == 200, uploaded.text

        owner_list = await workshop_list_skills(user_id=owner_id)
        other_list = await workshop_list_skills(user_id=other_id)

        assert skill_name in set(owner_list.get("skills") or [])
        assert skill_name not in set(other_list.get("skills") or [])
    finally:
        with TestClient(app) as client:
            client.delete(f"/api/v1/skills/{skill_name}", headers={"X-User-ID": owner_id})
        _cleanup_skill(skill_name)
