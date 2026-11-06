"""共创房间行为合同 T01–T12。断言是期望行为。"""

import asyncio
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import app
from backend.db import async_session_maker
from sqlalchemy import func, select

from backend.models.output_asset import OutputAsset
from backend.models.project import Project
from backend.models.project_attachment import ProjectAttachment
from backend.models.project_room import ProjectRoom, ProjectRoomMessage
from backend.services import project_room_service as rooms
from backend.services.file_action_service import apply_file_action
from backend.services.room_writer import build_writer_messages
from tests.test_project_rooms import (
    _create_project,
    _create_room,
    _headers,
    _messages,
    _post,
    room_roles,
)

pytestmark = pytest.mark.usefixtures("room_roles")


def _archive_project(project_id: str) -> None:
    async def run() -> None:
        async with async_session_maker() as db:
            project = await db.get(Project, project_id)
            assert project is not None
            project.status = "archived"
            await db.commit()

    asyncio.run(run())


def _output_count(project_id: str) -> int:
    async def run() -> int:
        async with async_session_maker() as db:
            count = await db.scalar(
                select(func.count()).select_from(OutputAsset).where(OutputAsset.project_id == project_id)
            )
            return int(count or 0)

    return asyncio.run(run())


def test_t01_concurrent_enqueue_keeps_both_messages(room_roles):
    owner = f"room_owner_{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        room_id = _create_room(client, owner, project_id)["id"]

    async def send(text: str) -> None:
        async with async_session_maker() as db:
            await rooms.enqueue_human_message(
                db,
                project_id=project_id,
                room_id=room_id,
                user_id=owner,
                content=text,
            )

    async def both() -> None:
        await asyncio.gather(send("并发甲"), send("并发乙"))

    asyncio.run(both())
    with TestClient(app) as client:
        payload = _messages(client, owner, project_id, room_id)
    contents = [item["content"] for item in payload["messages"]]
    assert contents.count("并发甲") == 1
    assert contents.count("并发乙") == 1
    seqs = [item["seq"] for item in payload["messages"]]
    assert len(seqs) == len(set(seqs))


def test_t02_client_message_id_is_idempotent(room_roles):
    owner = f"room_owner_{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        room_id = _create_room(client, owner, project_id)["id"]
        body = {"content": "同一句", "client_message_id": "msg-1"}
        first = client.post(
            f"/api/v1/projects/{project_id}/rooms/{room_id}/messages",
            headers=_headers(owner),
            json=body,
        )
        second = client.post(
            f"/api/v1/projects/{project_id}/rooms/{room_id}/messages",
            headers=_headers(owner),
            json=body,
        )
        assert first.status_code == 200, first.text
        assert second.status_code == 200, second.text
        assert second.json()["id"] == first.json()["id"]
        assert second.json()["replayed"] is True
        conflict = client.post(
            f"/api/v1/projects/{project_id}/rooms/{room_id}/messages",
            headers=_headers(owner),
            json={"content": "另一句", "client_message_id": "msg-1"},
        )
        assert conflict.status_code == 409
        payload = _messages(client, owner, project_id, room_id)
        assert [item["content"] for item in payload["messages"] if item["author_type"] == "human"] == ["同一句"]


def test_t03_stale_base_version_returns_conflict(room_roles):
    owner = f"room_owner_{uuid.uuid4().hex[:8]}"
    other = f"room_editor_{uuid.uuid4().hex[:8]}"
    calls = {"n": 0}

    async def editor(role, ctx):
        del role
        calls["n"] += 1
        version = str((ctx.get("target") or {}).get("version") or "")
        file_id = str((ctx.get("target") or {}).get("file_id") or "")
        async with async_session_maker() as db:
            await apply_file_action(
                db,
                ctx_project,
                effective_uid=other,
                action={
                    "type": "patch",
                    "target_file_id": file_id,
                    "content": f"# 别人\n\n别人的版本 {calls['n']}\n",
                    "edit_mode": "full",
                    "base_version": version,
                    "file_name": "共创结果.md",
                },
                proposal_id=f"other-{uuid.uuid4().hex}",
            )
        return "# 主笔\n\n主笔新稿\n"

    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        from tests.test_project_rooms import _add_member

        _add_member(client, owner, project_id, other, "editor")
        room_id = _create_room(client, owner, project_id, title="共创结果")["id"]
        _post(client, owner, project_id, room_id, "负责人先写一版")
    asyncio.run(rooms.drain_project_room(room_id))
    ctx_project = project_id
    rooms.set_room_completer_for_tests(editor)
    with TestClient(app) as client:
        _post(client, owner, project_id, room_id, "再写一版")
    asyncio.run(rooms.drain_project_room(room_id))
    with TestClient(app) as client:
        done = _messages(client, owner, project_id, room_id)
        assert "别人的版本" in done["content"]
        assert "主笔新稿" not in done["content"]
        assert calls["n"] >= 2
        failed = [item for item in done["messages"] if item["content"] == "再写一版"]
        assert failed[0]["turn_state"] == "failed"
        assert failed[0]["error_code"] == 409


def test_version_conflict_requeues_and_writes_latest(room_roles):
    owner = f"room_owner_{uuid.uuid4().hex[:8]}"
    other = f"room_editor_{uuid.uuid4().hex[:8]}"
    calls = {"n": 0}

    async def editor(role, ctx):
        del role
        calls["n"] += 1
        version = str((ctx.get("target") or {}).get("version") or "")
        file_id = str((ctx.get("target") or {}).get("file_id") or "")
        if calls["n"] == 1:
            async with async_session_maker() as db:
                await apply_file_action(
                    db,
                    ctx_project,
                    effective_uid=other,
                    action={
                        "type": "patch",
                        "target_file_id": file_id,
                        "content": "# 别人\n\n别人的版本\n",
                        "edit_mode": "full",
                        "base_version": version,
                        "file_name": "共创结果.md",
                    },
                    proposal_id=f"other-{uuid.uuid4().hex}",
                )
            return "# 主笔\n\n过期稿\n"
        assert "别人的版本" in str(ctx.get("document") or "")
        return "# 主笔\n\n排队后的修订\n"

    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        from tests.test_project_rooms import _add_member

        _add_member(client, owner, project_id, other, "editor")
        room_id = _create_room(client, owner, project_id, title="共创结果")["id"]
        _post(client, owner, project_id, room_id, "负责人先写一版")
    asyncio.run(rooms.drain_project_room(room_id))
    ctx_project = project_id
    rooms.set_room_completer_for_tests(editor)
    with TestClient(app) as client:
        _post(client, owner, project_id, room_id, "再写一版")
    asyncio.run(rooms.drain_project_room(room_id))
    with TestClient(app) as client:
        done = _messages(client, owner, project_id, room_id)
        assert calls["n"] >= 2
        assert "排队后的修订" in done["content"]
        assert "过期稿" not in done["content"]
        revised = [item for item in done["messages"] if item["content"] == "再写一版"]
        assert revised[0]["turn_state"] == "succeeded"


def test_t04_archived_project_and_room_do_not_write(room_roles):
    owner = f"room_owner_{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        room_id = _create_room(client, owner, project_id)["id"]
    _archive_project(project_id)
    with TestClient(app) as client:
        _post(client, owner, project_id, room_id, "请写一版归档后的稿")
    asyncio.run(rooms.drain_project_room(room_id))
    with TestClient(app) as client:
        payload = _messages(client, owner, project_id, room_id)
        assert payload["doc_version"] == 0
        assert not payload["output_id"]
        archived = client.patch(
            f"/api/v1/projects/{project_id}/rooms/{room_id}",
            headers=_headers(owner),
            json={"archived": True},
        )
    assert archived.status_code in {200, 403}


def test_t05_model_and_commit_failures_do_not_split_output(room_roles):
    owner = f"room_owner_{uuid.uuid4().hex[:8]}"

    async def boom(role, ctx):
        del role, ctx
        raise RuntimeError("模型失败")

    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        room_id = _create_room(client, owner, project_id)["id"]
        _post(client, owner, project_id, room_id, "请写一版")
    rooms.set_room_completer_for_tests(boom)
    asyncio.run(rooms.drain_project_room(room_id))
    with TestClient(app) as client:
        failed = _messages(client, owner, project_id, room_id)
        human = next(item for item in failed["messages"] if item["author_type"] == "human")
        assert human["turn_state"] == "failed"
        assert "模型失败" in human["error_summary"]
        assert failed["doc_version"] == 0
        assert human["content"] == "请写一版"

    rooms.set_room_completer_for_tests(rooms.mock_room_reply)

    async def break_commit() -> None:
        raise RuntimeError("房间指针提交失败")

    rooms.set_turn_commit_hook_for_tests(break_commit)
    with TestClient(app) as client:
        room_id = _create_room(client, owner, project_id, title="提交边界")["id"]
        _post(client, owner, project_id, room_id, "请再写一版")
    asyncio.run(rooms.drain_project_room(room_id))
    rooms.set_turn_commit_hook_for_tests(None)
    with TestClient(app) as client:
        split = _messages(client, owner, project_id, room_id)
        assert split["doc_version"] == 0
        assert not split["output_id"]
        assert _output_count(project_id) == 0


def test_t06_file_body_enters_context_without_leaking_foreign_title(room_roles):
    owner = f"room_owner_{uuid.uuid4().hex[:8]}"
    seen: list[dict] = []

    async def capture(role, ctx):
        del role
        seen.append(ctx)
        return "只回答，不落稿。"

    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        other_id = _create_project(client, owner)
        room_id = _create_room(client, owner, project_id)["id"]
        created = client.post(
            f"/api/v1/projects/{other_id}/file-actions/apply",
            headers=_headers(owner),
            json={
                "proposal_id": f"secret-{uuid.uuid4().hex}",
                "action": {
                    "type": "create",
                    "file_name": "机密标题ZZ.md",
                    "content": "机密正文不该出现",
                },
            },
        )
        assert created.status_code == 200, created.text
        secret_id = created.json()["result_file_id"]
        leaked = client.post(
            f"/api/v1/projects/{project_id}/rooms/{room_id}/messages",
            headers=_headers(owner),
            json={
                "content": "看看别的项目",
                "files": [
                    {
                        "project_id": other_id,
                        "file_id": secret_id,
                        "kind": "output",
                        "purpose": "material",
                    }
                ],
            },
        )
        assert leaked.status_code == 403
        assert "机密标题ZZ" not in leaked.text
        assert "机密正文" not in leaked.text
        own = client.post(
            f"/api/v1/projects/{project_id}/file-actions/apply",
            headers=_headers(owner),
            json={
                "proposal_id": f"own-{uuid.uuid4().hex}",
                "action": {"type": "create", "file_name": "本项目附件.md", "content": "正文标记OMEGA"},
            },
        )
        assert own.status_code == 200, own.text
        rooms.set_room_completer_for_tests(capture)
        posted = client.post(
            f"/api/v1/projects/{project_id}/rooms/{room_id}/messages",
            headers=_headers(owner),
            json={
                "content": "解读资料",
                "agent_mode": "ask",
                "files": [
                    {
                        "project_id": project_id,
                        "file_id": own.json()["result_file_id"],
                        "kind": "output",
                        "purpose": "material",
                    }
                ],
            },
        )
        assert posted.status_code == 200, posted.text
    asyncio.run(rooms.drain_project_room(room_id))
    assert seen
    blob = str(seen[-1].get("materials"))
    assert "正文标记OMEGA" in blob
    assert "机密标题ZZ" not in blob


def test_t07_manual_save_uses_room_contract(room_roles):
    owner = f"room_owner_{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        room_id = _create_room(client, owner, project_id)["id"]
        _post(client, owner, project_id, room_id, "负责人先写一版")
    asyncio.run(rooms.drain_project_room(room_id))
    with TestClient(app) as client:
        current = _messages(client, owner, project_id, room_id)
        output_id = current["output_id"]
        denied = client.post(
            f"/api/v1/projects/{project_id}/file-actions/apply",
            headers=_headers(owner),
            json={
                "session_id": room_id,
                "proposal_id": f"bad-{uuid.uuid4().hex}",
                "action": {
                    "type": "patch",
                    "target_file_id": output_id,
                    "content": "误走旧会话",
                    "base_version": "1",
                },
            },
        )
        assert denied.status_code == 403
        saved = client.post(
            f"/api/v1/projects/{project_id}/file-actions/apply",
            headers=_headers(owner),
            json={
                "room_id": room_id,
                "proposal_id": f"hand-{uuid.uuid4().hex}",
                "action": {
                    "type": "patch",
                    "target_file_id": output_id,
                    "content": "# 手改\n\n手工正文\n",
                    "edit_mode": "full",
                    "base_version": "1",
                },
            },
        )
        assert saved.status_code == 200, saved.text
        stale = client.post(
            f"/api/v1/projects/{project_id}/file-actions/apply",
            headers=_headers(owner),
            json={
                "room_id": room_id,
                "proposal_id": f"stale-{uuid.uuid4().hex}",
                "action": {
                    "type": "patch",
                    "target_file_id": output_id,
                    "content": "旧版本覆盖",
                    "edit_mode": "full",
                    "base_version": "1",
                },
            },
        )
        assert stale.status_code == 409


def test_t09_revision_replaces_sentence(room_roles):
    owner = f"room_owner_{uuid.uuid4().hex[:8]}"

    async def revise(role, ctx):
        del role
        if "删除原句" in str(ctx.get("human_text")):
            return "# 正式稿\n\n只留下新句子。\n"
        return "# 正式稿\n\n原句保留。\n只留下新句子。\n"

    rooms.set_room_completer_for_tests(revise)
    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        room_id = _create_room(client, owner, project_id, title="正式稿")["id"]
        _post(client, owner, project_id, room_id, "请写一版")
    asyncio.run(rooms.drain_project_room(room_id))
    with TestClient(app) as client:
        _post(client, owner, project_id, room_id, "删除原句：原句保留")
    asyncio.run(rooms.drain_project_room(room_id))
    with TestClient(app) as client:
        done = _messages(client, owner, project_id, room_id)
        assert "原句保留" not in done["content"]
        assert "只留下新句子" in done["content"]
        assert "删除原句" not in done["content"]


def test_t10_plan_and_denial_do_not_bypass_write(room_roles):
    owner = f"room_owner_{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        room_id = _create_room(client, owner, project_id)["id"]
        asked = client.post(
            f"/api/v1/projects/{project_id}/rooms/{room_id}/messages",
            headers=_headers(owner),
            json={"content": "请写一版但只问答", "agent_mode": "ask"},
        )
        assert asked.status_code == 200
        bare = client.post(
            f"/api/v1/projects/{project_id}/rooms/{room_id}/messages",
            headers=_headers(owner),
            json={"content": "开始执行", "agent_mode": "agent"},
        )
        assert bare.status_code == 200
    asyncio.run(rooms.drain_project_room(room_id))
    with TestClient(app) as client:
        assert _messages(client, owner, project_id, room_id)["doc_version"] == 0
        client.post(
            f"/api/v1/projects/{project_id}/rooms/{room_id}/messages",
            headers=_headers(owner),
            json={"content": "先出计划", "agent_mode": "plan"},
        )
    asyncio.run(rooms.drain_project_room(room_id))
    with TestClient(app) as client:
        planned = _messages(client, owner, project_id, room_id)
        assert planned["doc_version"] == 0
        assert planned["plan_version"] == 1
        client.post(
            f"/api/v1/projects/{project_id}/rooms/{room_id}/messages",
            headers=_headers(owner),
            json={"content": "不要生成文档，请写一版", "agent_mode": "agent"},
        )
    asyncio.run(rooms.drain_project_room(room_id))
    with TestClient(app) as client:
        assert _messages(client, owner, project_id, room_id)["doc_version"] == 0
        client.post(
            f"/api/v1/projects/{project_id}/rooms/{room_id}/messages",
            headers=_headers(owner),
            json={
                "content": "开始执行",
                "agent_mode": "agent",
                "plan_id": planned["plan_id"],
                "plan_version": 1,
            },
        )
    asyncio.run(rooms.drain_project_room(room_id))
    with TestClient(app) as client:
        confirmed = _messages(client, owner, project_id, room_id)
        assert confirmed["doc_version"] == 1
        client.post(
            f"/api/v1/projects/{project_id}/rooms/{room_id}/messages",
            headers=_headers(owner),
            json={"content": "计划改一版", "agent_mode": "plan"},
        )
    asyncio.run(rooms.drain_project_room(room_id))
    with TestClient(app) as client:
        revised = _messages(client, owner, project_id, room_id)
        assert revised["plan_version"] == 2
        assert revised["plan_confirmed_version"] in (None, "")
        stale = client.post(
            f"/api/v1/projects/{project_id}/rooms/{room_id}/messages",
            headers=_headers(owner),
            json={"content": "开始执行", "agent_mode": "plan", "plan_version": 1},
        )
        assert stale.status_code == 200
    asyncio.run(rooms.drain_project_room(room_id))
    with TestClient(app) as client:
        final = _messages(client, owner, project_id, room_id)
        assert final["doc_version"] == 1


def test_t11_recover_does_not_duplicate_applied_action(room_roles):
    owner = f"room_owner_{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        room_id = _create_room(client, owner, project_id)["id"]
        posted = _post(client, owner, project_id, room_id, "先排队")
        turn_id = posted["turn_id"]
        cancelled = client.post(
            f"/api/v1/projects/{project_id}/rooms/{room_id}/turns/{turn_id}/cancel",
            headers=_headers(owner),
        )
        assert cancelled.status_code == 200, cancelled.text
    asyncio.run(rooms.drain_project_room(room_id))
    with TestClient(app) as client:
        payload = _messages(client, owner, project_id, room_id)
        assert payload["messages"][0]["turn_state"] == "cancelled"
        assert payload["doc_version"] == 0
        _post(client, owner, project_id, room_id, "请写一版")
    asyncio.run(rooms.drain_project_room(room_id))

    async def expire() -> str:
        async with async_session_maker() as db:
            room = await db.get(ProjectRoom, room_id)
            assert room is not None
            human = (
                await db.execute(
                    select(ProjectRoomMessage).where(
                        ProjectRoomMessage.room_id == room_id,
                        ProjectRoomMessage.content == "请写一版",
                    )
                )
            ).scalar_one()
            room.active_turn_id = human.turn_id
            room.lease_until = "2000-01-01T00:00:00"
            human.turn_state = "running"
            content = (await db.get(OutputAsset, room.output_id)).content
            await db.commit()
            return content

    before = asyncio.run(expire())
    asyncio.run(rooms.recover_incomplete_turns())
    with TestClient(app) as client:
        done = _messages(client, owner, project_id, room_id)
        assert done["content"] == before
        assert done["doc_version"] == 1
        humans = [item for item in done["messages"] if item["content"] == "请写一版"]
        assert humans[0]["turn_state"] == "succeeded"


def test_t12_writer_reads_attachment_and_revises(room_roles, tmp_path: Path, monkeypatch):
    owner = f"room_owner_{uuid.uuid4().hex[:8]}"
    source = tmp_path / "note.md"
    source.write_text("附件原句ALPHA\n待删句子BETA\n", encoding="utf-8")
    calls: list[list[dict[str, str]]] = []

    async def upstream(messages):
        calls.append(messages)
        user = "\n".join(item.get("content") or "" for item in messages if item.get("role") == "user")
        assert "附件原句ALPHA" in user
        if "删除原句" in user:
            return "# 引用稿\n\n附件原句ALPHA\n"
        return "# 引用稿\n\n附件原句ALPHA\n待删句子BETA\n"

    monkeypatch.setattr(rooms, "writer_driver_name", lambda: "hermes")
    monkeypatch.setattr("backend.services.room_writer.writer_driver_name", lambda: "hermes")
    monkeypatch.setattr("backend.services.room_writer.request_writer_completion", upstream)
    rooms.set_room_completer_for_tests(None)
    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        room_id = _create_room(client, owner, project_id, title="引用稿")["id"]

    async def add_attachment() -> str:
        async with async_session_maker() as db:
            row = ProjectAttachment(
                id=str(uuid.uuid4()),
                project_id=project_id,
                original_filename="note.md",
                content_type="text/markdown",
                size_bytes=source.stat().st_size,
                stored_path=str(source),
            )
            db.add(row)
            await db.commit()
            return row.id

    attachment_id = asyncio.run(add_attachment())
    with TestClient(app) as client:
        _post_files = client.post(
            f"/api/v1/projects/{project_id}/rooms/{room_id}/messages",
            headers=_headers(owner),
            json={
                "content": "请根据附件写一版",
                "files": [
                    {
                        "project_id": project_id,
                        "file_id": attachment_id,
                        "kind": "attachment",
                        "purpose": "material",
                    }
                ],
            },
        )
        assert _post_files.status_code == 200, _post_files.text
    asyncio.run(rooms.drain_project_room(room_id))
    with TestClient(app) as client:
        drafted = _messages(client, owner, project_id, room_id)
        assert "附件原句ALPHA" in drafted["content"]
        assert "待删句子BETA" in drafted["content"]
        assert "请根据附件写一版" not in drafted["content"]
        assert drafted["messages"][0]["run_id"]
        client.post(
            f"/api/v1/projects/{project_id}/rooms/{room_id}/messages",
            headers=_headers(owner),
            json={
                "content": "删除原句待删句子BETA",
                "files": [
                    {
                        "project_id": project_id,
                        "file_id": drafted["output_id"],
                        "kind": "output",
                        "purpose": "revise",
                        "version": "1",
                    }
                ],
            },
        )
    asyncio.run(rooms.drain_project_room(room_id))
    with TestClient(app) as client:
        revised = _messages(client, owner, project_id, room_id)
        assert "待删句子BETA" not in revised["content"]
        assert "附件原句ALPHA" in revised["content"]
    assert calls
    prompt = build_writer_messages(
        {"id": "writer", "system": "主笔"},
        {"materials": [], "human_text": "", "allow_write": True, "run_id": "run-1"},
    )
    assert "TPCharness_run_id=run-1" in prompt[0]["content"]
    assert prompt[0]["role"] == "system"


def test_event_cursor_sees_interleaved_agent_message(room_roles):
    owner = f"room_owner_{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        room_id = _create_room(client, owner, project_id)["id"]

    async def seed() -> None:
        async with async_session_maker() as db:
            db.add(
                ProjectRoomMessage(
                    id=str(uuid.uuid4()),
                    room_id=room_id,
                    seq=2000,
                    event_seq=1,
                    turn_id="late-human",
                    author_type="human",
                    author_id=owner,
                    author_name=owner,
                    content="后入库的人话",
                    turn_state="succeeded",
                )
            )
            db.add(
                ProjectRoomMessage(
                    id=str(uuid.uuid4()),
                    room_id=room_id,
                    seq=1001,
                    event_seq=2,
                    turn_id="early-agent",
                    author_type="agent",
                    author_id="writer",
                    author_name="主笔",
                    content="后插入的前轮回复",
                    turn_state="succeeded",
                )
            )
            db.add(
                ProjectRoomMessage(
                    id=str(uuid.uuid4()),
                    room_id=room_id,
                    seq=500,
                    event_seq=0,
                    turn_id="open-turn",
                    author_type="human",
                    author_id=owner,
                    author_name=owner,
                    content="仍在排队",
                    turn_state="queued",
                )
            )
            await db.commit()

    asyncio.run(seed())
    with TestClient(app) as client:
        page = client.get(
            f"/api/v1/projects/{project_id}/rooms/{room_id}/messages",
            headers=_headers(owner),
            params={"after_event": 1},
        )
        assert page.status_code == 200, page.text
        body = page.json()
        contents = [item["content"] for item in body["messages"]]
        assert contents == ["后插入的前轮回复"]
        states = {item["turn_id"]: item["turn_state"] for item in body["turn_states"]}
        assert "late-human" not in states
        assert states["open-turn"] == "queued"


def test_message_window_returns_latest_page(room_roles):
    owner = f"room_owner_{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        room_id = _create_room(client, owner, project_id)["id"]

    async def seed() -> None:
        async with async_session_maker() as db:
            for seq in range(1, 4):
                db.add(
                    ProjectRoomMessage(
                        id=str(uuid.uuid4()),
                        room_id=room_id,
                        seq=seq,
                        event_seq=seq,
                        turn_id=f"turn-{seq}",
                        author_type="human",
                        author_id=owner,
                        author_name=owner,
                        content=f"第{seq}句",
                        turn_state="succeeded",
                    )
                )
            await db.commit()

    asyncio.run(seed())
    with TestClient(app) as client:
        page = client.get(
            f"/api/v1/projects/{project_id}/rooms/{room_id}/messages",
            headers=_headers(owner),
            params={"limit": 2, "known_doc_version": 0},
        )
        assert page.status_code == 200, page.text
        body = page.json()
        assert [item["content"] for item in body["messages"]] == ["第2句", "第3句"]
        assert body["has_more"] is True
        assert body["content_omitted"] is True
        older = client.get(
            f"/api/v1/projects/{project_id}/rooms/{room_id}/messages",
            headers=_headers(owner),
            params={"before_seq": body["oldest_seq"], "limit": 2},
        )
        assert older.status_code == 200, older.text
        assert [item["content"] for item in older.json()["messages"]] == ["第1句"]
        assert older.json()["has_more"] is False
