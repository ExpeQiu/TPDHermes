"""项目共创群聊：成员可见、@ 角色、主笔写回。"""

import asyncio
import uuid

import pytest
from fastapi.testclient import TestClient

from backend import app
from backend.services import project_room_service as rooms

ROLES = [
    {"id": "writer", "name": "主笔", "system": "你是主笔"},
    {"id": "alpha", "name": "角色甲", "system": "你是甲"},
    {"id": "beta", "name": "角色乙", "system": "你是乙"},
]


async def _list_roles():
    return {"items": ROLES, "source": "test"}


async def _get_role(role_id: str):
    for role in ROLES:
        if role["id"] == role_id:
            return dict(role)
    raise rooms.MultiAgentResourceError("missing", status_code=404)


@pytest.fixture
def room_roles(monkeypatch):
    monkeypatch.setattr(rooms, "list_roles", _list_roles)
    monkeypatch.setattr(rooms, "get_role", _get_role)
    monkeypatch.setattr(
        "backend.routes.project_rooms.schedule_room_drain",
        lambda background_tasks, room_id: None,
    )
    rooms.set_room_completer_for_tests(rooms.mock_room_reply)
    yield
    rooms.set_room_completer_for_tests(None)


def _headers(user_id: str) -> dict[str, str]:
    return {"X-User-ID": user_id}


def _create_project(client: TestClient, user_id: str) -> str:
    response = client.post(
        "/api/v1/projects/",
        headers=_headers(user_id),
        json={"name": f"群聊{uuid.uuid4().hex[:6]}", "status": "active"},
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _add_member(client: TestClient, owner: str, project_id: str, user_id: str, role: str) -> None:
    response = client.post(
        f"/api/v1/projects/{project_id}/members",
        headers=_headers(owner),
        json={"user_id": user_id, "role": role},
    )
    assert response.status_code == 200, response.text


def _create_room(client: TestClient, user_id: str, project_id: str, title: str = "共创结果") -> dict:
    response = client.post(
        f"/api/v1/projects/{project_id}/rooms",
        headers=_headers(user_id),
        json={
            "title": title,
            "role_ids": ["writer", "alpha", "beta"],
            "writer_role_id": "writer",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def _post(client: TestClient, user_id: str, project_id: str, room_id: str, content: str) -> dict:
    response = client.post(
        f"/api/v1/projects/{project_id}/rooms/{room_id}/messages",
        headers=_headers(user_id),
        json={"content": content},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _messages(client: TestClient, user_id: str, project_id: str, room_id: str, after: int = 0) -> dict:
    response = client.get(
        f"/api/v1/projects/{project_id}/rooms/{room_id}/messages",
        headers=_headers(user_id),
        params={"after": after},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_rename_and_archive_room(room_roles):
    owner = f"room_owner_{uuid.uuid4().hex[:8]}"
    viewer = f"room_view_{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        _add_member(client, owner, project_id, viewer, "viewer")
        room_id = _create_room(client, owner, project_id, title="待改名")["id"]
        renamed = client.patch(
            f"/api/v1/projects/{project_id}/rooms/{room_id}",
            headers=_headers(owner),
            json={"title": "  发布会讨论  "},
        )
        assert renamed.status_code == 200, renamed.text
        assert renamed.json()["title"] == "发布会讨论"
        assert renamed.json()["archived_at"] in (None, "")

        denied = client.patch(
            f"/api/v1/projects/{project_id}/rooms/{room_id}",
            headers=_headers(viewer),
            json={"title": "只读不能改"},
        )
        assert denied.status_code == 404

        archived = client.patch(
            f"/api/v1/projects/{project_id}/rooms/{room_id}",
            headers=_headers(owner),
            json={"archived": True},
        )
        assert archived.status_code == 200, archived.text
        assert archived.json()["archived_at"]
        listed = client.get(f"/api/v1/projects/{project_id}/rooms", headers=_headers(owner))
        assert listed.status_code == 200
        row = next(item for item in listed.json()["items"] if item["id"] == room_id)
        assert row["archived_at"]

        restored = client.patch(
            f"/api/v1/projects/{project_id}/rooms/{room_id}",
            headers=_headers(owner),
            json={"archived": False},
        )
        assert restored.status_code == 200, restored.text
        assert not restored.json()["archived_at"]


def test_create_room_without_agents(room_roles):
    owner = f"room_owner_{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        response = client.post(
            f"/api/v1/projects/{project_id}/rooms",
            headers=_headers(owner),
            json={"title": "先开会"},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["role_ids"] == []
        assert body["writer_role_id"] == ""


def test_seat_role_into_existing_room(room_roles):
    owner = f"room_owner_{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        created = client.post(
            f"/api/v1/projects/{project_id}/rooms",
            headers=_headers(owner),
            json={"title": "先开会"},
        )
        assert created.status_code == 200, created.text
        room_id = created.json()["id"]
        seated = client.patch(
            f"/api/v1/projects/{project_id}/rooms/{room_id}",
            headers=_headers(owner),
            json={"role_ids": ["alpha"], "writer_role_id": "alpha"},
        )
        assert seated.status_code == 200, seated.text
        body = seated.json()
        assert body["role_ids"] == ["alpha"]
        assert body["writer_role_id"] == "alpha"

        unknown = client.patch(
            f"/api/v1/projects/{project_id}/rooms/{room_id}",
            headers=_headers(owner),
            json={"role_ids": ["missing"]},
        )
        assert unknown.status_code == 400

        archived = client.patch(
            f"/api/v1/projects/{project_id}/rooms/{room_id}",
            headers=_headers(owner),
            json={"archived": True},
        )
        assert archived.status_code == 200, archived.text
        denied = client.patch(
            f"/api/v1/projects/{project_id}/rooms/{room_id}",
            headers=_headers(owner),
            json={"role_ids": ["writer"], "writer_role_id": "writer"},
        )
        assert denied.status_code == 400


def test_human_visible_before_agents_and_queue(room_roles):
    owner = f"room_owner_{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        room = _create_room(client, owner, project_id, title=f"排队{uuid.uuid4().hex[:4]}")
        room_id = room["id"]
        first = _post(client, owner, project_id, room_id, "第一句甲")
        second = _post(client, owner, project_id, room_id, "第二句乙")
        pending = _messages(client, owner, project_id, room_id)
        assert [item["author_type"] for item in pending["messages"]] == ["human", "human"]
        assert pending["messages"][0]["content"] == "第一句甲"
        assert pending["messages"][0]["seq"] < pending["messages"][1]["seq"]
        assert first["turn_state"] == "running"
        assert second["turn_state"] == "queued"
        assert pending["doc_version"] == 0

    asyncio.run(rooms.drain_project_room(room_id))

    with TestClient(app) as client:
        done = _messages(client, owner, project_id, room_id)
        kinds = [item["author_type"] for item in done["messages"]]
        assert kinds == ["human", "agent", "human", "agent"]
        assert done["messages"][0]["content"] == "第一句甲"
        assert done["messages"][1]["author_id"] == "hermes-agent"
        assert done["messages"][2]["content"] == "第二句乙"
        assert done["messages"][2]["seq"] > done["messages"][1]["seq"]
        assert "第一句甲" in done["messages"][3]["content"]
        assert done["doc_version"] == 0
        assert not done["output_id"]


def test_mentions_roles_and_members_share_transcript(room_roles):
    owner = f"room_owner_{uuid.uuid4().hex[:8]}"
    editor = f"room_editor_{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        _add_member(client, owner, project_id, editor, "editor")
        room_id = _create_room(client, owner, project_id, title=f"提及{uuid.uuid4().hex[:4]}")["id"]
        _post(client, owner, project_id, room_id, "基线词ZZZ")
        _post(client, editor, project_id, room_id, "@角色甲 只叫甲")
        _post(client, editor, project_id, room_id, "@角色甲 @角色乙 一起看")

    asyncio.run(rooms.drain_project_room(room_id))

    with TestClient(app) as client:
        payload = _messages(client, editor, project_id, room_id)
        humans = [item for item in payload["messages"] if item["author_type"] == "human"]
        assert [item["content"] for item in humans] == ["基线词ZZZ", "@角色甲 只叫甲", "@角色甲 @角色乙 一起看"]
        by_turn: dict[str, list[dict]] = {}
        for item in payload["messages"]:
            if item["author_type"] == "agent":
                by_turn.setdefault(item["turn_id"], []).append(item)
        only_alpha = by_turn[humans[1]["turn_id"]]
        assert [item["author_id"] for item in only_alpha] == ["alpha"]
        assert "基线词ZZZ" in only_alpha[0]["content"]
        both = by_turn[humans[2]["turn_id"]]
        assert [item["author_id"] for item in both] == ["alpha", "beta"]
        assert "角色甲回应" in both[1]["content"]
        assert payload["doc_version"] == 0
        assert not payload["output_id"]


def test_ask_skips_write_and_plan_writes_after_confirm(room_roles):
    owner = f"room_owner_{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        room_id = _create_room(client, owner, project_id, title=f"模式{uuid.uuid4().hex[:4]}")["id"]
        asked = client.post(
            f"/api/v1/projects/{project_id}/rooms/{room_id}/messages",
            headers=_headers(owner),
            json={"content": "这版只问不改", "agent_mode": "ask"},
        )
        assert asked.status_code == 200, asked.text
        assert asked.json()["agent_mode"] == "ask"

    asyncio.run(rooms.drain_project_room(room_id))

    with TestClient(app) as client:
        asked_done = _messages(client, owner, project_id, room_id)
        assert asked_done["doc_version"] == 0
        assert not asked_done["output_id"]
        assert any(item["author_type"] == "agent" for item in asked_done["messages"])
        planned = client.post(
            f"/api/v1/projects/{project_id}/rooms/{room_id}/messages",
            headers=_headers(owner),
            json={"content": "先出计划", "agent_mode": "plan"},
        )
        assert planned.status_code == 200, planned.text

    asyncio.run(rooms.drain_project_room(room_id))

    with TestClient(app) as client:
        planned_done = _messages(client, owner, project_id, room_id)
        assert planned_done["doc_version"] == 0
        confirmed = client.post(
            f"/api/v1/projects/{project_id}/rooms/{room_id}/messages",
            headers=_headers(owner),
            json={"content": "开始执行", "agent_mode": "plan"},
        )
        assert confirmed.status_code == 200, confirmed.text

    asyncio.run(rooms.drain_project_room(room_id))

    with TestClient(app) as client:
        done = _messages(client, owner, project_id, room_id)
        assert done["doc_version"] == 1
        assert done["output_id"]
        plan_reply = next(
            item["content"]
            for item in done["messages"]
            if item["author_type"] == "agent" and "行动计划" in item["content"]
        )
        assert "请确认后开始执行" in plan_reply


def test_viewer_does_not_write_and_outsider_cannot_read(room_roles):
    owner = f"room_owner_{uuid.uuid4().hex[:8]}"
    viewer = f"room_viewer_{uuid.uuid4().hex[:8]}"
    outsider = f"room_out_{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        _add_member(client, owner, project_id, viewer, "viewer")
        room_id = _create_room(client, owner, project_id, title=f"权限{uuid.uuid4().hex[:4]}")["id"]
        _post(client, owner, project_id, room_id, "负责人先写一版")

    asyncio.run(rooms.drain_project_room(room_id))

    with TestClient(app) as client:
        before = _messages(client, viewer, project_id, room_id)
        assert before["doc_version"] == 1
        assert before["output_id"]
        spoken = _post(client, viewer, project_id, room_id, "只读成员插一句")
        assert spoken["author_id"] == viewer
        denied = client.post(
            f"/api/v1/projects/{project_id}/rooms",
            headers=_headers(viewer),
            json={"title": "不行", "role_ids": ["writer"], "writer_role_id": "writer"},
        )
        assert denied.status_code == 404
        hidden = client.get(
            f"/api/v1/projects/{project_id}/rooms/{room_id}/messages",
            headers=_headers(outsider),
        )
        assert hidden.status_code == 404

    asyncio.run(rooms.drain_project_room(room_id))

    with TestClient(app) as client:
        after = _messages(client, owner, project_id, room_id)
        assert after["doc_version"] == 1
        assert after["output_id"] == before["output_id"]
        assert "只读成员插一句" not in after["content"]
        assert any(item["content"] == "只读成员插一句" for item in after["messages"])


def test_room_voices_include_speakers_and_mentions(room_roles):
    owner = f"room_owner_{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        room_id = _create_room(client, owner, project_id)["id"]
        spoken = client.post(
            f"/api/v1/projects/{project_id}/rooms/{room_id}/messages",
            headers=_headers(owner),
            json={"content": "请角色甲看一下", "mention_role_ids": ["alpha"]},
        )
        assert spoken.status_code == 200, spoken.text
        voices = client.get(f"/api/v1/projects/{project_id}/rooms/voices", headers=_headers(owner))
        assert voices.status_code == 200, voices.text
        body = voices.json()
        assert owner in body["user_ids"]
        assert "alpha" in body["role_ids"]


def test_mentioned_agents_revise_existing_document_in_order(room_roles):
    owner = f"room_owner_{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        room_id = _create_room(client, owner, project_id, title="竞品对标")["id"]
        _post(client, owner, project_id, room_id, "将以上整理成文稿")

    asyncio.run(rooms.drain_project_room(room_id))

    with TestClient(app) as client:
        created = _messages(client, owner, project_id, room_id)
        assert created["doc_version"] == 1
        revised = client.post(
            f"/api/v1/projects/{project_id}/rooms/{room_id}/messages",
            headers=_headers(owner),
            json={
                "content": "@角色甲 @角色乙 请修订文稿",
                "mention_role_ids": ["alpha", "beta"],
            },
        )
        assert revised.status_code == 200, revised.text

    asyncio.run(rooms.drain_project_room(room_id))

    with TestClient(app) as client:
        done = _messages(client, owner, project_id, room_id)
        assert done["doc_version"] == 2
        assert done["output_id"] == created["output_id"]
        humans = [item for item in done["messages"] if item["content"] == "@角色甲 @角色乙 请修订文稿"]
        agents = [item for item in done["messages"] if item["turn_id"] == humans[0]["turn_id"] and item["author_type"] == "agent"]
        assert [item["author_id"] for item in agents] == ["alpha", "beta"]
        assert "角色乙回应" in done["content"]


def test_document_intent_separates_chat_create_and_revise():
    from backend.services.room_contract import (
        authorized_hermes_action,
        classify_document_intent,
        manuscript_for_file,
        project_file_body,
    )

    assert classify_document_intent("将以上整理成文稿") == "create"
    assert classify_document_intent("转成报告") == "create"
    assert classify_document_intent("帮我写个方案") == "create"
    assert classify_document_intent("删除原句待删句子") == "revise"
    assert classify_document_intent("@角色甲 请修订文稿") == "revise"
    assert classify_document_intent("@角色甲 只叫甲") == "chat"
    assert classify_document_intent("文稿和话术有什么区别") == "chat"
    assert classify_document_intent("生成式人工智能是什么") == "chat"
    assert classify_document_intent("存档以上文档") == "create"
    assert classify_document_intent("不要生成文档，请写一版") == "deny"
    archived = project_file_body(
        "已存档于 /opt/data/输出/报告.md。平台写入被标记为禁止，未落库。",
        ["Hermes: # 千里浩瀚\n\n正式正文"],
    )
    assert archived.startswith("# 千里浩瀚")
    parsed = authorized_hermes_action(
        "说明\n```TPCharness_file_actions\n- action: create\n- path: /输出/新文档 版本.md\n- content: |\n    # 千里浩瀚\n    正文\n```"
    )
    assert parsed is not None
    assert parsed["file_name"] == "新文档 版本.md"
    assert parsed["content"].startswith("# 千里浩瀚")
    saved = manuscript_for_file("已整理成稿，并落盘于 /opt/data/输出/报告.md（平台写入被标记为禁止）。\n\n# 千里浩瀚\n\n正文")
    assert saved.startswith("# 千里浩瀚")


def test_hermes_file_action_is_executed(room_roles):
    owner = f"room_owner_{uuid.uuid4().hex[:8]}"

    async def editor(role, ctx):
        del role, ctx
        return (
            "已按授权准备落库。\n\n"
            "```TPCharness_file_actions\n"
            '{"actions":[{"type":"create","fileName":"竞品洞察.md","path":"/输出/竞品洞察.md",'
            '"content":"# 竞品洞察\\n\\n正式正文"}]}\n'
            "```"
        )

    rooms.set_room_completer_for_tests(editor)
    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        room_id = _create_room(client, owner, project_id, title="竞品洞察")["id"]
        _post(client, owner, project_id, room_id, "你好")

    asyncio.run(rooms.drain_project_room(room_id))

    with TestClient(app) as client:
        done = _messages(client, owner, project_id, room_id)
        assert done["doc_version"] >= 1
        assert done["output_id"]
        assert "正式正文" in done["content"]
        assert "TPCharness_file_actions" not in done["content"]


def test_arrange_into_manuscript_creates_project_file(room_roles):
    owner = f"room_owner_{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        room_id = _create_room(client, owner, project_id, title="竞品对标")["id"]
        _post(client, owner, project_id, room_id, "先讨论千里浩瀚")
        _post(client, owner, project_id, room_id, "将以上整理成文稿")

    asyncio.run(rooms.drain_project_room(room_id))

    with TestClient(app) as client:
        done = _messages(client, owner, project_id, room_id)
        assert done["doc_version"] >= 1
        assert done["output_id"]
        assert "整理成文稿" in done["content"]
        chat = client.post(
            f"/api/v1/projects/{project_id}/rooms/{room_id}/messages",
            headers=_headers(owner),
            json={"content": "文稿和话术有什么区别"},
        )
        assert chat.status_code == 200, chat.text
        chat_turn = chat.json()["turn_id"]

    asyncio.run(rooms.drain_project_room(room_id))

    with TestClient(app) as client:
        after = _messages(client, owner, project_id, room_id)
        assert after["doc_version"] == done["doc_version"]
        spoken = next(item for item in after["messages"] if item["turn_id"] == chat_turn and item["author_type"] == "agent")
        assert spoken["author_id"] == "hermes-agent"


def test_plain_message_talks_to_hermes_member_mention_does_not(room_roles):
    owner = f"room_owner_{uuid.uuid4().hex[:8]}"
    editor = f"room_editor_{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        _add_member(client, owner, project_id, editor, "editor")
        room_id = _create_room(client, owner, project_id)["id"]
        _post(client, owner, project_id, room_id, "你好")
        mentioned = client.post(
            f"/api/v1/projects/{project_id}/rooms/{room_id}/messages",
            headers=_headers(owner),
            json={"content": f"@{editor} 你看一下", "mention_user_ids": [editor]},
        )
        assert mentioned.status_code == 200, mentioned.text

    asyncio.run(rooms.drain_project_room(room_id))

    with TestClient(app) as client:
        payload = _messages(client, owner, project_id, room_id)
        by_turn: dict[str, list[dict]] = {}
        humans = [item for item in payload["messages"] if item["author_type"] == "human"]
        for item in payload["messages"]:
            if item["author_type"] == "agent":
                by_turn.setdefault(item["turn_id"], []).append(item)
        assert [item["author_id"] for item in by_turn[humans[0]["turn_id"]]] == ["hermes-agent"]
        assert humans[0]["content"] == "你好"
        assert "Hermes回应：你好" in by_turn[humans[0]["turn_id"]][0]["content"]
        assert humans[1]["turn_id"] not in by_turn
        assert humans[1]["turn_state"] == "succeeded"
