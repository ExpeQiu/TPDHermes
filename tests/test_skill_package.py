"""技能包目录 API 与 skill_package 服务测试。"""

import shutil
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import app
from backend.services.skill_loader import get_loader
from backend.services.skill_package import (
    SkillPackageError,
    create_layout_item,
    init_skill_md,
    list_package,
    read_package_file,
    write_package_file,
)


def _ensure_hello_skill_installed(client: TestClient) -> str:
    name = "hello_skill"
    detail = client.get(f"/api/v1/skills/{name}")
    if detail.status_code == 404:
        installed = client.post(
            "/api/v1/skills/",
            json={"name": name, "description": "test", "source": "local"},
        )
        assert installed.status_code == 200, installed.text
    return name


def test_skill_package_service_path_safety(tmp_path: Path):
    root = tmp_path / "demo_skill"
    root.mkdir()
    (root / "SKILL.md").write_text("# Demo\n", encoding="utf-8")
    (root / "scripts").mkdir()
    (root / "scripts" / "run.sh").write_text("#!/bin/sh\necho ok\n", encoding="utf-8")

    pkg = list_package(root, "demo_skill")
    assert pkg["standard_layout"]["SKILL.md"] is True
    assert pkg["standard_layout"]["scripts"] is True

    data = read_package_file(root, "SKILL.md")
    assert data["content"] == "# Demo\n"

    write_package_file(root, "references/note.md", "## ref\n")
    assert (root / "references" / "note.md").is_file()

    with pytest.raises(SkillPackageError):
        read_package_file(root, "../outside.md")

    created = create_layout_item(root, "demo_skill", "assets", "demo desc")
    assert created["open_path"] == "assets/README.md"
    assert (root / "assets" / "README.md").is_file()

    with pytest.raises(SkillPackageError):
        create_layout_item(root, "demo_skill", "assets")


def test_skill_package_api_list_read_write_init():
    loader = get_loader()
    skill_name = f"pkgskill_{uuid.uuid4().hex[:8]}"
    skill_dir = loader.skills_root / skill_name
    if skill_dir.exists():
        shutil.rmtree(skill_dir)

    code = f"""from backend.services.skill_loader import Skill

class PkgSkill(Skill):
    @property
    def name(self):
        return "{skill_name}"

    def generate(self, context):
        return {{"ok": True}}

    def validate_input(self, input_data):
        return True
"""
    try:
        skill_dir.mkdir(parents=True)
        (skill_dir / "__init__.py").write_text(code, encoding="utf-8")

        with TestClient(app) as client:
            installed = client.post(
                "/api/v1/skills/",
                json={"name": skill_name, "description": "pkg test", "source": "local"},
            )
            assert installed.status_code == 200, installed.text

            pkg = client.get(f"/api/v1/skills/{skill_name}/package")
            assert pkg.status_code == 200, pkg.text
            body = pkg.json()
            assert body["standard_layout"]["__init__.py"] is True
            assert body["standard_layout"]["SKILL.md"] is False

            created = client.post(f"/api/v1/skills/{skill_name}/package/init-skill-md")
            assert created.status_code == 200, created.text
            assert "name:" in created.json()["content"]

            read_md = client.get(
                f"/api/v1/skills/{skill_name}/package/file",
                params={"path": "SKILL.md"},
            )
            assert read_md.status_code == 200, read_md.text
            assert read_md.json()["editable"] is True

            saved = client.put(
                f"/api/v1/skills/{skill_name}/package/file",
                json={"path": "SKILL.md", "content": "---\nname: x\n---\n# Updated\n"},
            )
            assert saved.status_code == 200, saved.text

            assert (skill_dir / "SKILL.md").read_text(encoding="utf-8").startswith("---")

            refs = client.post(
                f"/api/v1/skills/{skill_name}/package/layout-item",
                json={"item": "references"},
            )
            assert refs.status_code == 200, refs.text
            assert (skill_dir / "references" / "README.md").is_file()

            skill_json = client.post(
                f"/api/v1/skills/{skill_name}/package/layout-item",
                json={"item": "skill.json"},
            )
            assert skill_json.status_code == 200, skill_json.text
            assert (skill_dir / "skill.json").is_file()

            deleted = client.delete(f"/api/v1/skills/{skill_name}")
            assert deleted.status_code == 200, deleted.text
    finally:
        if skill_dir.exists():
            shutil.rmtree(skill_dir)
        loader._cache.pop(skill_name, None)


def test_skill_package_api_hello_skill_if_present():
    with TestClient(app) as client:
        name = _ensure_hello_skill_installed(client)
        pkg = client.get(f"/api/v1/skills/{name}/package")
        assert pkg.status_code == 200, pkg.text
        assert "__init__.py" in pkg.json()["standard_layout"]
