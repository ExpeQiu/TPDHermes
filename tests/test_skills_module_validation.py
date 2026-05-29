import io
import shutil
import uuid
import zipfile

from fastapi.testclient import TestClient

from backend import app
from backend.services.skill_loader import get_loader
from backend.services.skill_version import SkillVersionService


def _build_skill_zip(name: str) -> bytes:
    code = f"""from backend.services.skill_loader import Skill

class UploadedSkill(Skill):
    @property
    def name(self):
        return "{name}"

    def generate(self, context):
        return {{"ok": True, "name": self.name, "context": context}}

    def validate_input(self, input_data):
        return isinstance(input_data, dict)
"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"{name}/__init__.py", code)
    return buf.getvalue()


def _cleanup_uploaded_skill(name: str) -> None:
    loader = get_loader()
    skill_dir = loader.skills_root / name
    version_dir = SkillVersionService.VERSION_ROOT / name
    if skill_dir.exists():
        shutil.rmtree(skill_dir)
    if version_dir.exists():
        shutil.rmtree(version_dir)
    loader._cache.pop(name, None)


def test_skills_upload_skill_md_zip():
    """SKILL.md 标准布局 ZIP 可上传（自动生成 __init__.py 桩）。"""
    name = f"mdskill_{uuid.uuid4().hex[:8]}"
    skill_md = f"""---
name: {name}
description: markdown skill upload test
---

# Test Skill
"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"{name}/SKILL.md", skill_md)
        zf.writestr(f"{name}/scripts/run.py", "print('ok')\n")
    zip_bytes = buf.getvalue()
    _cleanup_uploaded_skill(name)

    try:
        with TestClient(app) as client:
            uploaded = client.post(
                "/api/v1/skills/upload",
                files={"file": (f"{name}.zip", zip_bytes, "application/zip")},
            )
            assert uploaded.status_code == 200, uploaded.text
            body = uploaded.json()
            assert body["name"] == name
            assert "markdown skill upload test" in body["description"]

            loader = get_loader()
            assert (loader.skills_root / name / "__init__.py").is_file()
            assert (loader.skills_root / name / "SKILL.md").is_file()

            deleted = client.delete(f"/api/v1/skills/{name}")
            assert deleted.status_code == 200, deleted.text
    finally:
        _cleanup_uploaded_skill(name)


def test_skills_upload_replace_existing_upload_skill():
    """已安装的上传技能可被同用户或其他用户重新上传覆盖。"""
    name = f"mdskill_{uuid.uuid4().hex[:8]}"
    skill_md_v1 = f"""---
name: {name}
description: version one
---

# Test Skill v1
"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"{name}/SKILL.md", skill_md_v1)
    zip_v1 = buf.getvalue()
    _cleanup_uploaded_skill(name)

    try:
        with TestClient(app) as client:
            first = client.post(
                "/api/v1/skills/upload",
                files={"file": (f"{name}.zip", zip_v1, "application/zip")},
                headers={"X-User-ID": "user_a"},
            )
            assert first.status_code == 200, first.text
            assert first.json()["owner_id"] == "user_a"

            skill_md_v2 = skill_md_v1.replace("version one", "version two")
            buf2 = io.BytesIO()
            with zipfile.ZipFile(buf2, "w", zipfile.ZIP_DEFLATED) as zf:
                zf.writestr(f"{name}/SKILL.md", skill_md_v2)
            second = client.post(
                "/api/v1/skills/upload",
                files={"file": (f"{name}.zip", buf2.getvalue(), "application/zip")},
                headers={"X-User-ID": "user_b"},
            )
            assert second.status_code == 200, second.text
            body = second.json()
            assert body["owner_id"] == "user_b"
            assert "version two" in body["description"]
            assert body["version"] == "1.0.1"

            deleted = client.delete(f"/api/v1/skills/{name}")
            assert deleted.status_code == 200, deleted.text
    finally:
        _cleanup_uploaded_skill(name)


def test_skills_upload_update_toggle_config_and_cleanup():
    name = f"zipskill_{uuid.uuid4().hex[:8]}"
    zip_bytes = _build_skill_zip(name)
    _cleanup_uploaded_skill(name)

    try:
        with TestClient(app) as client:
            uploaded = client.post(
                "/api/v1/skills/upload",
                files={"file": (f"{name}.zip", zip_bytes, "application/zip")},
                data={"description": "zip upload regression"},
            )
            assert uploaded.status_code == 200, uploaded.text
            uploaded_body = uploaded.json()
            assert uploaded_body["name"] == name
            assert uploaded_body["scope"] == "personal"
            assert uploaded_body["enabled"] is True

            disabled = client.patch(
                f"/api/v1/skills/{name}/enable",
                json={"enabled": False},
            )
            assert disabled.status_code == 200, disabled.text
            assert disabled.json()["enabled"] is False

            configured = client.patch(
                f"/api/v1/skills/{name}/config",
                json={"config": {"token": "abc", "mode": "test"}},
            )
            assert configured.status_code == 200, configured.text
            assert configured.json()["config"] == {"token": "abc", "mode": "test"}

            updated = client.put(
                f"/api/v1/skills/{name}",
                json={"changelog": "bump for validation"},
            )
            assert updated.status_code == 200, updated.text
            assert updated.json()["version"] == "1.0.1"

            versions = client.get(f"/api/v1/skills/{name}/versions")
            assert versions.status_code == 200, versions.text
            assert {
                item["version"] for item in versions.json()["versions"]
            } >= {"1.0.0", "1.0.1"}

            loaded = client.post(f"/api/v1/skills/{name}/versions/1.0.1/load")
            assert loaded.status_code == 200, loaded.text
            assert loaded.json()["version_loaded"] == "1.0.1"

            deleted = client.delete(f"/api/v1/skills/{name}")
            assert deleted.status_code == 200, deleted.text

            detail = client.get(f"/api/v1/skills/{name}")
            assert detail.status_code == 404, detail.text
    finally:
        _cleanup_uploaded_skill(name)


def test_skills_publish_global_admin_only_and_visible_to_others():
    name = f"pubskill_{uuid.uuid4().hex[:8]}"
    zip_bytes = _build_skill_zip(name)
    _cleanup_uploaded_skill(name)

    try:
        with TestClient(app) as client:
            uploaded = client.post(
                "/api/v1/skills/upload",
                files={"file": (f"{name}.zip", zip_bytes, "application/zip")},
                headers={"X-User-ID": "user_owner_publish"},
            )
            assert uploaded.status_code == 200, uploaded.text
            assert uploaded.json().get("owner_id") == "user_owner_publish"

            forbidden = client.patch(
                f"/api/v1/skills/{name}/publish-global",
                json={"publish": True},
                headers={"X-User-ID": "user_not_admin"},
            )
            assert forbidden.status_code == 403, forbidden.text

            published = client.patch(
                f"/api/v1/skills/{name}/publish-global",
                json={"publish": True},
                headers={"X-User-ID": "default"},
            )
            assert published.status_code == 200, published.text
            assert published.json().get("owner_id") == ""

            visible = client.get("/api/v1/skills/", headers={"X-User-ID": "user_random_viewer"})
            assert visible.status_code == 200, visible.text
            names = {item["name"] for item in visible.json()}
            assert name in names
    finally:
        with TestClient(app) as client:
            client.delete(f"/api/v1/skills/{name}", headers={"X-User-ID": "default"})
        _cleanup_uploaded_skill(name)
