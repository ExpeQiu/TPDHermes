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
                "selectedProjectId": "proj-keep",
                "pinnedFileIds": ["output:a"],
                "roundFileIds": ["output:b"],
                "coCreateApplyMode": "review",
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
        assert patched_body["selectedProjectId"] == "proj-keep"
        assert patched_body["pinnedFileIds"] == ["output:a"]
        assert patched_body["roundFileIds"] == ["output:c"]
        assert patched_body["archived"] is False
        assert patched_body["coCreateApplyMode"] == "review"

        titled = client.patch(
            f"/api/v1/chat/sessions/{sid}",
            headers=headers,
            json={"title": "改标题", "pinnedFileIds": ["output:d"]},
        )
        assert titled.status_code == 200
        titled_body = titled.json()
        assert titled_body["title"] == "改标题"
        assert titled_body["sessionKind"] == "project_co_create"
        assert titled_body["selectedProjectId"] == "proj-keep"
        assert titled_body["pinnedFileIds"] == ["output:d"]
        assert titled_body["roundFileIds"] == ["output:c"]

        rejected = client.patch(
            f"/api/v1/chat/sessions/{sid}",
            headers=headers,
            json={"sessionKind": "not-a-kind"},
        )
        assert rejected.status_code == 400

        detail = client.get(f"/api/v1/chat/sessions/{sid}", headers=headers)
        assert detail.status_code == 200
        detail_body = detail.json()
        assert detail_body["sessionKind"] == "project_co_create"
        assert detail_body["selectedProjectId"] == "proj-keep"
        assert detail_body["pinnedFileIds"] == ["output:d"]
        assert detail_body["roundFileIds"] == ["output:c"]
        assert detail_body["title"] == "改标题"
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
        assert second.status_code == 409, second.text
        assert second.json()["detail"]["code"] == "name_conflict"
        assert second.json()["detail"]["existing_file_id"] == first_id

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
        assert detail.json()["content"] == "# 第一版"


def test_project_file_create_upserts_title_stem_without_md_suffix():
    headers = {"X-User-ID": f"co_create_stem_{uuid.uuid4().hex[:8]}"}
    with TestClient(app) as client:
        proj = client.post(
            "/api/v1/projects",
            headers=headers,
            json={"name": "共创 stem 项目", "status": "active"},
        )
        assert proj.status_code == 200
        project_id = proj.json()["id"]

        first = client.post(
            f"/api/v1/projects/{project_id}/file-actions/apply",
            headers=headers,
            json={
                "proposal_id": "create-stem-first",
                "action": {
                    "type": "create",
                    "file_name": "通用对话",
                    "path": "/输出/通用对话",
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
                "proposal_id": "create-stem-second",
                "action": {
                    "type": "create",
                    "file_name": "通用对话.md",
                    "path": "/输出/通用对话.md",
                    "content": "# 第二版",
                },
            },
        )
        assert second.status_code == 409, second.text
        assert second.json()["detail"]["existing_file_id"] == first_id

        files = client.get(f"/api/v1/projects/{project_id}/files", headers=headers)
        assert files.status_code == 200
        outputs = [item for item in files.json()["items"] if item["kind"] == "output"]
        assert len(outputs) == 1
        assert outputs[0]["title"] == "通用对话.md"
        assert outputs[0]["id"] == first_id
        detail = client.get(
            f"/api/v1/projects/{project_id}/files/{first_id}?kind=output",
            headers=headers,
        )
        assert detail.json()["content"] == "# 第一版"


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


def test_attachment_markdown_preview():
    headers = {"X-User-ID": f"co_create_md_{uuid.uuid4().hex[:8]}"}
    with TestClient(app) as client:
        proj = client.post(
            "/api/v1/projects",
            headers=headers,
            json={"name": "附件预览项目", "status": "active"},
        )
        assert proj.status_code == 200
        project_id = proj.json()["id"]

        uploaded = client.post(
            f"/api/v1/projects/{project_id}/attachments",
            headers=headers,
            files={"file": ("report.md", b"# Title\n\nPreview body", "text/markdown")},
        )
        assert uploaded.status_code == 200, uploaded.text
        attachment_id = uploaded.json()["id"]

        detail = client.get(
            f"/api/v1/projects/{project_id}/files/{attachment_id}?kind=attachment",
            headers=headers,
        )
        assert detail.status_code == 200, detail.text
        body = detail.json()
        assert "Preview body" in body["content"]
        assert body["content_format"] == "markdown"


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


def test_same_proposal_is_idempotent_and_rename_keeps_history():
    headers = {"X-User-ID": f"co_create_idem_{uuid.uuid4().hex[:8]}"}
    with TestClient(app) as client:
        proj = client.post(
            "/api/v1/projects",
            headers=headers,
            json={"name": "幂等项目", "status": "active"},
        )
        project_id = proj.json()["id"]
        payload = {
            "proposal_id": "same-create",
            "action": {
                "type": "create",
                "file_name": "幂等稿.md",
                "path": "/输出",
                "content": "# 一次",
            },
        }
        first = client.post(
            f"/api/v1/projects/{project_id}/file-actions/apply",
            headers=headers,
            json=payload,
        )
        assert first.status_code == 200, first.text
        file_id = first.json()["file_id"]
        action_id = first.json()["action_id"]
        second = client.post(
            f"/api/v1/projects/{project_id}/file-actions/apply",
            headers=headers,
            json=payload,
        )
        assert second.status_code == 200, second.text
        assert second.json()["file_id"] == file_id
        assert second.json()["idempotent_replay"] is True

        changed = client.post(
            f"/api/v1/projects/{project_id}/file-actions/apply",
            headers=headers,
            json={
                "proposal_id": "same-create",
                "action": {
                    "type": "create",
                    "file_name": "幂等稿.md",
                    "path": "/输出",
                    "content": "# 另一份",
                },
            },
        )
        assert changed.status_code == 409
        assert changed.json()["detail"]["code"] == "proposal_payload"

        patched = client.post(
            f"/api/v1/projects/{project_id}/file-actions/apply",
            headers=headers,
            json={
                "proposal_id": "rename-after-edit",
                "action": {
                    "type": "patch",
                    "target_file_id": file_id,
                    "content": "# 二次",
                    "save_mode": "overwrite",
                    "base_version": "1",
                },
            },
        )
        assert patched.status_code == 200, patched.text
        renamed = client.post(
            f"/api/v1/projects/{project_id}/file-actions/apply",
            headers=headers,
            json={
                "proposal_id": "rename-title",
                "action": {
                    "type": "patch",
                    "target_file_id": file_id,
                    "file_name": "改名稿.md",
                    "content": "# 二次",
                    "save_mode": "overwrite",
                    "base_version": patched.json()["result_version"],
                },
            },
        )
        assert renamed.status_code == 200, renamed.text
        versions = client.get(
            f"/api/v1/projects/{project_id}/files/{file_id}/versions?kind=output",
            headers=headers,
        )
        assert versions.status_code == 200
        assert len(versions.json()["items"]) >= 2

        undone = client.post(
            f"/api/v1/projects/{project_id}/file-actions/{action_id}/undo",
            headers=headers,
        )
        assert undone.status_code == 409

        created_only = client.post(
            f"/api/v1/projects/{project_id}/file-actions/apply",
            headers=headers,
            json={
                "proposal_id": "undo-create",
                "action": {
                    "type": "create",
                    "file_name": "待撤销.md",
                    "path": "/输出",
                    "content": "# 撤销我",
                },
            },
        )
        assert created_only.status_code == 200, created_only.text
        undo_ok = client.post(
            f"/api/v1/projects/{project_id}/file-actions/{created_only.json()['action_id']}/undo",
            headers=headers,
        )
        assert undo_ok.status_code == 200, undo_ok.text
        listed = client.get(f"/api/v1/projects/{project_id}/files", headers=headers)
        titles = [item["title"] for item in listed.json()["items"]]
        assert "待撤销.md" not in titles


def test_stale_base_version_does_not_overwrite():
    headers = {"X-User-ID": f"co_create_ver_{uuid.uuid4().hex[:8]}"}
    with TestClient(app) as client:
        proj = client.post(
            "/api/v1/projects",
            headers=headers,
            json={"name": "版本冲突项目", "status": "active"},
        )
        assert proj.status_code == 200
        project_id = proj.json()["id"]
        created = client.post(
            f"/api/v1/projects/{project_id}/file-actions/apply",
            headers=headers,
            json={
                "proposal_id": "ver-create",
                "action": {
                    "type": "create",
                    "file_name": "并发稿.md",
                    "path": "/输出",
                    "content": "# 第一版",
                },
            },
        )
        assert created.status_code == 200, created.text
        file_id = created.json()["file_id"]
        newer = client.post(
            f"/api/v1/projects/{project_id}/file-actions/apply",
            headers=headers,
            json={
                "proposal_id": "ver-new",
                "action": {
                    "type": "patch",
                    "target_file_id": file_id,
                    "content": "# 第二版",
                    "save_mode": "overwrite",
                    "base_version": "1",
                },
            },
        )
        assert newer.status_code == 200, newer.text
        assert newer.json()["version"] == "2"

        stale = client.post(
            f"/api/v1/projects/{project_id}/file-actions/apply",
            headers=headers,
            json={
                "proposal_id": "ver-stale",
                "action": {
                    "type": "patch",
                    "target_file_id": file_id,
                    "content": "# 旧提案",
                    "save_mode": "overwrite",
                    "base_version": "1",
                },
            },
        )
        assert stale.status_code == 409
        assert stale.json()["detail"]["current_version"] == "2"

        detail = client.get(
            f"/api/v1/projects/{project_id}/files/{file_id}?kind=output",
            headers=headers,
        )
        assert detail.status_code == 200
        assert detail.json()["content"] == "# 第二版"
        assert detail.json()["version"] == "2"


def test_file_apply_rejects_ask_and_unconfirmed_plan():
    headers = {"X-User-ID": f"co_create_guard_{uuid.uuid4().hex[:8]}"}
    with TestClient(app) as client:
        proj = client.post(
            "/api/v1/projects",
            headers=headers,
            json={"name": "写入边界项目", "status": "active"},
        )
        assert proj.status_code == 200
        project_id = proj.json()["id"]
        other = client.post(
            "/api/v1/projects",
            headers=headers,
            json={"name": "另一个项目", "status": "active"},
        )
        other_id = other.json()["id"]

        def _session(mode: str, phase: str | None = None, selected: str | None = None) -> str:
            body: dict = {
                "title": "边界会话",
                "sessionKind": "project_co_create",
                "selectedProjectId": selected or project_id,
                "coCreateAgentMode": mode,
            }
            if phase:
                body["coCreatePlanPhase"] = phase
            created = client.post("/api/v1/chat/sessions", headers=headers, json=body)
            assert created.status_code == 200, created.text
            return created.json()["id"]

        def _apply(session_id: str):
            return client.post(
                f"/api/v1/projects/{project_id}/file-actions/apply",
                headers=headers,
                json={
                    "session_id": session_id,
                    "proposal_id": f"guard-{uuid.uuid4().hex[:6]}",
                    "action": {
                        "type": "create",
                        "file_name": "不应写入.md",
                        "path": "/输出",
                        "content": "# 不应落库",
                    },
                },
            )

        ask_id = _session("ask")
        ask_apply = _apply(ask_id)
        assert ask_apply.status_code == 403
        assert "Ask" in ask_apply.json()["detail"]

        plan_id = _session("plan", "awaiting_confirm")
        plan_apply = _apply(plan_id)
        assert plan_apply.status_code == 403
        assert "计划未确认" in plan_apply.json()["detail"]

        mismatch_id = _session("agent", selected=other_id)
        mismatch = _apply(mismatch_id)
        assert mismatch.status_code == 403
        assert "不属于当前项目" in mismatch.json()["detail"]

        files = client.get(f"/api/v1/projects/{project_id}/files", headers=headers)
        titles = [item["title"] for item in files.json()["items"]]
        assert "不应写入.md" not in titles

        executing_id = _session("plan", "executing")
        stale_plan = _apply(executing_id)
        assert stale_plan.status_code == 403
        assert "计划确认已失效" in stale_plan.json()["detail"]

        confirmed = client.post(
            "/api/v1/chat/sessions",
            headers=headers,
            json={
                "title": "已确认计划",
                "sessionKind": "project_co_create",
                "selectedProjectId": project_id,
                "coCreateAgentMode": "plan",
                "coCreatePlanPhase": "executing",
                "coCreatePlanId": "plan-a",
                "coCreatePlanVersion": "v1",
                "coCreateConfirmedPlanId": "plan-a",
                "coCreateConfirmedPlanVersion": "v1",
            },
        )
        assert confirmed.status_code == 200, confirmed.text
        allowed = _apply(confirmed.json()["id"])
        assert allowed.status_code == 200, allowed.text
        assert allowed.json()["ok"] is True

        revised = client.patch(
            f"/api/v1/chat/sessions/{confirmed.json()['id']}",
            headers=headers,
            json={"coCreatePlanVersion": "v2", "coCreatePlanId": "plan-b"},
        )
        assert revised.status_code == 200, revised.text
        assert revised.json()["coCreatePlanPhase"] == "awaiting_confirm"
        assert revised.json().get("coCreateConfirmedPlanVersion") in ("", None)
        blocked = _apply(confirmed.json()["id"])
        assert blocked.status_code == 403
