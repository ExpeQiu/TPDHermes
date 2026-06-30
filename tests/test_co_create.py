"""项目共创 API 测试。"""

import uuid

from fastapi.testclient import TestClient

from backend import app
from backend.services.file_action_service import parse_file_actions_from_content

TEST_USER = f"co_create_test_{uuid.uuid4().hex[:8]}"


def test_parse_file_actions_from_content():
    content = """一些正文

```tphermes_file_actions
{"actions": [{"type": "create", "proposalId": "p1", "fileName": "a.md", "path": "/", "content": "# hi"}]}
```
"""
    actions = parse_file_actions_from_content(content)
    assert len(actions) == 1
    assert actions[0]["type"] == "create"
    assert actions[0]["file_name"] == "a.md"


def test_project_files_and_apply():
    headers = {"X-User-ID": TEST_USER}
    with TestClient(app) as client:
        proj = client.post(
            "/api/v1/projects",
            headers=headers,
            json={"name": "共创测试项目", "status": "active"},
        )
        assert proj.status_code == 200
        project_id = proj.json()["id"]

        files = client.get(f"/api/v1/projects/{project_id}/files", headers=headers)
        assert files.status_code == 200
        assert "items" in files.json()

        apply = client.post(
            f"/api/v1/projects/{project_id}/file-actions/apply",
            headers=headers,
            json={
                "proposal_id": "test-proposal",
                "action": {
                    "type": "create",
                    "file_name": "测试.md",
                    "path": "/测试",
                    "content": "# 测试内容",
                },
            },
        )
        assert apply.status_code == 200
        body = apply.json()
        assert body.get("ok") is True
        file_id = body["file_id"]

        detail = client.get(
            f"/api/v1/projects/{project_id}/files/{file_id}?kind=output",
            headers=headers,
        )
        assert detail.status_code == 200
        assert "测试内容" in detail.json().get("content", "")


def test_chat_session_co_create_context_roundtrip():
    headers = {"X-User-ID": f"co_create_ctx_{uuid.uuid4().hex[:8]}"}
    with TestClient(app) as client:
        create = client.post(
            "/api/v1/chat/sessions",
            headers=headers,
            json={
                "title": "共创会话",
                "sessionKind": "project_co_create",
                "pinnedFileIds": ["output:a"],
                "roundFileIds": ["output:b"],
            },
        )
        assert create.status_code == 200
        sid = create.json()["id"]
        patched = client.patch(
            f"/api/v1/chat/sessions/{sid}",
            headers=headers,
            json={"roundFileIds": ["output:c"], "archived": False},
        )
        assert patched.status_code == 200
        patched_body = patched.json()
        assert patched_body["sessionKind"] == "project_co_create"
        assert patched_body["pinnedFileIds"] == ["output:a"]
        assert patched_body["roundFileIds"] == ["output:c"]
        assert patched_body["archived"] is False

        detail = client.get(f"/api/v1/chat/sessions/{sid}", headers=headers)
        assert detail.status_code == 200
        detail_body = detail.json()
        assert detail_body["sessionKind"] == "project_co_create"
        assert detail_body["pinnedFileIds"] == ["output:a"]
        assert detail_body["roundFileIds"] == ["output:c"]
        assert detail_body["archived"] is False


def test_project_file_patch_creates_new_version_and_versions_endpoint():
    headers = {"X-User-ID": f"co_create_versions_{uuid.uuid4().hex[:8]}"}
    with TestClient(app) as client:
        proj = client.post(
            "/api/v1/projects",
            headers=headers,
            json={"name": "共创版本项目", "status": "active"},
        )
        assert proj.status_code == 200
        project_id = proj.json()["id"]

        created = client.post(
            f"/api/v1/projects/{project_id}/file-actions/apply",
            headers=headers,
            json={
                "proposal_id": "create-v1",
                "action": {
                    "type": "create",
                    "file_name": "版本说明.md",
                    "path": "/输出",
                    "content": "# 第一版",
                },
            },
        )
        assert created.status_code == 200, created.text
        created_body = created.json()
        original_file_id = created_body["file_id"]
        assert created_body["version"] == "1"

        patched = client.post(
            f"/api/v1/projects/{project_id}/file-actions/apply",
            headers=headers,
            json={
                "proposal_id": "patch-v2",
                "action": {
                    "type": "patch",
                    "target_file_id": original_file_id,
                    "target_kind": "output",
                    "file_name": "版本说明.md",
                    "content": "# 第二版",
                    "save_mode": "new_version",
                },
            },
        )
        assert patched.status_code == 200, patched.text
        patched_body = patched.json()
        assert patched_body["ok"] is True
        assert patched_body["file_id"] != original_file_id
        assert patched_body["version"] == "2"

        latest_detail = client.get(
            f"/api/v1/projects/{project_id}/files/{patched_body['file_id']}?kind=output",
            headers=headers,
        )
        assert latest_detail.status_code == 200
        assert latest_detail.json()["content"] == "# 第二版"

        versions = client.get(
            f"/api/v1/projects/{project_id}/files/{patched_body['file_id']}/versions?kind=output",
            headers=headers,
        )
        assert versions.status_code == 200, versions.text
        items = versions.json()["items"]
        assert len(items) == 2
        assert {item["version"] for item in items} == {"1", "2"}
        assert {item["id"] for item in items} == {original_file_id, patched_body["file_id"]}


def test_project_file_create_upserts_same_title():
    headers = {"X-User-ID": f"co_create_upsert_{uuid.uuid4().hex[:8]}"}
    with TestClient(app) as client:
        proj = client.post(
            "/api/v1/projects",
            headers=headers,
            json={"name": "共创 upsert 项目", "status": "active"},
        )
        assert proj.status_code == 200
        project_id = proj.json()["id"]

        first = client.post(
            f"/api/v1/projects/{project_id}/file-actions/apply",
            headers=headers,
            json={
                "proposal_id": "create-first",
                "action": {
                    "type": "create",
                    "file_name": "营销推广文案.md",
                    "path": "/输出/营销推广文案.md",
                    "content": "# 第一版",
                },
            },
        )
        assert first.status_code == 200, first.text
        first_id = first.json()["file_id"]

        second = client.post(
            f"/api/v1/projects/{project_id}/file-actions/apply",
            headers=headers,
            json={
                "proposal_id": "create-second",
                "action": {
                    "type": "create",
                    "file_name": "营销推广文案.md",
                    "path": "/输出/营销推广文案.md",
                    "content": "# 第二版",
                },
            },
        )
        assert second.status_code == 200, second.text
        second_body = second.json()
        assert second_body["file_id"] == first_id
        assert second_body["version"] == "2"

        files = client.get(f"/api/v1/projects/{project_id}/files", headers=headers)
        assert files.status_code == 200
        outputs = [item for item in files.json()["items"] if item["kind"] == "output"]
        marketing = [item for item in outputs if item["title"] == "营销推广文案.md"]
        assert len(marketing) == 1

        detail = client.get(
            f"/api/v1/projects/{project_id}/files/{first_id}?kind=output",
            headers=headers,
        )
        assert detail.status_code == 200
        assert detail.json()["content"] == "# 第二版"


def test_attachment_is_visible_in_unified_files_and_project_context():
    headers = {"X-User-ID": f"co_create_attachment_{uuid.uuid4().hex[:8]}"}
    with TestClient(app) as client:
        proj = client.post(
            "/api/v1/projects",
            headers=headers,
            json={"name": "共创附件项目", "status": "active"},
        )
        assert proj.status_code == 200
        project_id = proj.json()["id"]

        uploaded = client.post(
            f"/api/v1/projects/{project_id}/attachments",
            headers=headers,
            files={"file": ("brief.txt", b"line1\nline2\n", "text/plain")},
        )
        assert uploaded.status_code == 200, uploaded.text
        attachment_id = uploaded.json()["id"]

        files = client.get(f"/api/v1/projects/{project_id}/files", headers=headers)
        assert files.status_code == 200
        attachment_items = [item for item in files.json()["items"] if item["kind"] == "attachment"]
        assert any(item["id"] == attachment_id for item in attachment_items)

        detail = client.get(
            f"/api/v1/projects/{project_id}/files/{attachment_id}?kind=attachment",
            headers=headers,
        )
        assert detail.status_code == 200, detail.text
        detail_body = detail.json()
        assert detail_body["title"] == "brief.txt"
        assert "line1" in detail_body["content"]

        context = client.get(f"/api/v1/projects/{project_id}/context", headers=headers)
        assert context.status_code == 200, context.text
        context_body = context.json()
        assert any(item["id"] == attachment_id for item in context_body["attachments"])
        assert context_body["kb_stats"]["attachments_indexed"] == 0


def test_archived_output_is_hidden_from_unified_files_and_context():
    headers = {"X-User-ID": f"co_create_archive_{uuid.uuid4().hex[:8]}"}
    with TestClient(app) as client:
        proj = client.post(
            "/api/v1/projects",
            headers=headers,
            json={"name": "共创归档项目", "status": "active"},
        )
        assert proj.status_code == 200
        project_id = proj.json()["id"]

        deposited = client.post(
            f"/api/v1/projects/{project_id}/outputs/deposit-from-chat",
            headers=headers,
            json={"content": "待归档正文", "title": "待归档输出"},
        )
        assert deposited.status_code == 200, deposited.text
        output_id = deposited.json()["id"]

        before_archive = client.get(f"/api/v1/projects/{project_id}/files", headers=headers)
        assert before_archive.status_code == 200
        assert any(item["id"] == output_id for item in before_archive.json()["items"])

        archived = client.post(
            f"/api/v1/projects/{project_id}/outputs/{output_id}/archive",
            headers=headers,
        )
        assert archived.status_code == 200, archived.text
        assert archived.json()["status"] == "archived"

        outputs_default = client.get(f"/api/v1/projects/{project_id}/outputs", headers=headers)
        assert outputs_default.status_code == 200
        assert all(item["id"] != output_id for item in outputs_default.json())

        outputs_archived = client.get(
            f"/api/v1/projects/{project_id}/outputs?status=archived",
            headers=headers,
        )
        assert outputs_archived.status_code == 200
        assert any(item["id"] == output_id for item in outputs_archived.json())

        files_after_archive = client.get(f"/api/v1/projects/{project_id}/files", headers=headers)
        assert files_after_archive.status_code == 200
        assert all(item["id"] != output_id for item in files_after_archive.json()["items"])

        context = client.get(f"/api/v1/projects/{project_id}/context", headers=headers)
        assert context.status_code == 200
        assert all(item["id"] != output_id for item in context.json()["recent_outputs"])


def test_project_file_patch_search_replace_overwrite():
    headers = {"X-User-ID": f"co_create_sr_{uuid.uuid4().hex[:8]}"}
    with TestClient(app) as client:
        proj = client.post(
            "/api/v1/projects",
            headers=headers,
            json={"name": "局部替换项目", "status": "active"},
        )
        assert proj.status_code == 200
        project_id = proj.json()["id"]

        created = client.post(
            f"/api/v1/projects/{project_id}/file-actions/apply",
            headers=headers,
            json={
                "proposal_id": "create-sr",
                "action": {
                    "type": "create",
                    "file_name": "局部.md",
                    "path": "/",
                    "content": "第一行\n目标段落\n第三行",
                },
            },
        )
        assert created.status_code == 200, created.text
        file_id = created.json()["file_id"]

        patched = client.post(
            f"/api/v1/projects/{project_id}/file-actions/apply",
            headers=headers,
            json={
                "proposal_id": "patch-sr",
                "action": {
                    "type": "patch",
                    "target_file_id": file_id,
                    "target_kind": "output",
                    "file_name": "局部.md",
                    "save_mode": "overwrite",
                    "edit_mode": "search_replace",
                    "old_string": "目标段落",
                    "new_string": "已替换段落",
                },
            },
        )
        assert patched.status_code == 200, patched.text

        detail = client.get(
            f"/api/v1/projects/{project_id}/files/{file_id}?kind=output",
            headers=headers,
        )
        assert detail.status_code == 200
        assert detail.json()["content"] == "第一行\n已替换段落\n第三行"


def test_project_file_patch_overwrite_archives_version_history():
    """覆盖保存：原稿就地更新，旧内容归档为历史版本。"""
    headers = {"X-User-ID": f"co_create_ow_{uuid.uuid4().hex[:8]}"}
    with TestClient(app) as client:
        proj = client.post(
            "/api/v1/projects",
            headers=headers,
            json={"name": "覆盖版本项目", "status": "active"},
        )
        assert proj.status_code == 200
        project_id = proj.json()["id"]

        created = client.post(
            f"/api/v1/projects/{project_id}/file-actions/apply",
            headers=headers,
            json={
                "proposal_id": "create-ow",
                "action": {
                    "type": "create",
                    "file_name": "覆盖稿.md",
                    "path": "/输出",
                    "content": "# 第一版正文",
                },
            },
        )
        assert created.status_code == 200, created.text
        file_id = created.json()["file_id"]
        assert created.json()["version"] == "1"

        patched = client.post(
            f"/api/v1/projects/{project_id}/file-actions/apply",
            headers=headers,
            json={
                "proposal_id": "patch-ow",
                "action": {
                    "type": "patch",
                    "target_file_id": file_id,
                    "target_kind": "output",
                    "file_name": "覆盖稿.md",
                    "content": "# 第二版正文",
                    "save_mode": "overwrite",
                },
            },
        )
        assert patched.status_code == 200, patched.text
        body = patched.json()
        assert body["file_id"] == file_id
        assert body["version"] == "2"

        detail = client.get(
            f"/api/v1/projects/{project_id}/files/{file_id}?kind=output",
            headers=headers,
        )
        assert detail.status_code == 200
        assert detail.json()["content"] == "# 第二版正文"
        assert detail.json()["version"] == "2"

        versions = client.get(
            f"/api/v1/projects/{project_id}/files/{file_id}/versions?kind=output",
            headers=headers,
        )
        assert versions.status_code == 200
        items = versions.json()["items"]
        assert len(items) == 2
        version_nums = {item["version"] for item in items}
        assert version_nums == {"1", "2"}

        files = client.get(f"/api/v1/projects/{project_id}/files", headers=headers)
        assert files.status_code == 200
        output_titles = [item["title"] for item in files.json()["items"] if item["kind"] == "output"]
        assert output_titles.count("覆盖稿.md") == 1
