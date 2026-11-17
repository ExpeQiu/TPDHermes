"""技术推广包：权限、评估、生成、审核与导出。"""

from __future__ import annotations

import asyncio
import io
import json
import uuid
import zipfile

import pytest
from fastapi.testclient import TestClient

from backend import app
from backend.db import async_session_maker
from backend.models.promotion_package import PromotionPackageStep

SPEC = """技术名称：星海热管理
用户与场景：冬季通勤预热
卖点：上车即暖
机理：热泵回收余热
量化数据：8分钟
条件：环境零下7度
搭载范围：A级纯电
可公开口径：可对外发布舱温曲线
对比：公开资料约12分钟
知识库证据：doc_id=kb-demo-1 locator=第2节 claim=机理 value=热泵回收余热
联网线索：url=https://example.com/public-competitor claim=对比 value=公开资料约12分钟
"""

SPEC_NO_COMPARE = """技术名称：星海热管理
用户与场景：冬季通勤预热
卖点：上车即暖
机理：热泵回收余热
量化数据：8分钟
条件：环境零下7度
搭载范围：A级纯电
可公开口径：可对外发布舱温曲线
"""

SPEC_NO_METRIC = """技术名称：星海热管理
用户与场景：冬季通勤预热
卖点：上车即暖
机理：热泵回收余热
搭载范围：A级纯电
可公开口径：可对外发布舱温曲线
对比：公开资料约12分钟
"""

CONFLICT = "量化数据：12分钟\n"


def _headers(user_id: str) -> dict[str, str]:
    return {"X-User-ID": user_id}


def _create_project(client: TestClient, user_id: str) -> str:
    response = client.post(
        "/api/v1/projects/",
        headers=_headers(user_id),
        json={"name": f"推广{uuid.uuid4().hex[:6]}", "status": "active"},
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


def _upload(client: TestClient, user_id: str, project_id: str, name: str, content: bytes, content_type: str) -> str:
    response = client.post(
        f"/api/v1/projects/{project_id}/attachments",
        headers=_headers(user_id),
        files={"file": (name, content, content_type)},
    )
    assert response.status_code == 200, response.text
    return response.json()["id"]


def _create_package(client: TestClient, user_id: str, project_id: str, file_ids: list[str], key: str | None = None) -> dict:
    response = client.post(
        f"/api/v1/projects/{project_id}/promotion-packages",
        headers=_headers(user_id),
        json={
            "idempotency_key": key or uuid.uuid4().hex,
            "products": ["a4_skill", "tech_pr_skill", "interview_qa_skill"],
            "file_refs": [{"file_id": file_id, "kind": "attachment"} for file_id in file_ids],
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def _assess(client: TestClient, user_id: str, project_id: str, package: dict) -> dict:
    response = client.post(
        f"/api/v1/projects/{project_id}/promotion-packages/{package['id']}/assess",
        headers=_headers(user_id),
        json={"expected_revision": package["revision"]},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _confirm(client: TestClient, user_id: str, project_id: str, package: dict, facts: list[dict], adopted: list[str]) -> dict:
    response = client.post(
        f"/api/v1/projects/{project_id}/promotion-packages/{package['id']}/facts",
        headers=_headers(user_id),
        json={
            "expected_revision": package["revision"],
            "goal": "对外说明热管理体验",
            "audience": "行业媒体",
            "facts": facts,
            "adopted_candidate_ids": adopted,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def _file_facts(detail: dict, *, claims: set[str] | None = None) -> list[dict]:
    facts = []
    for field in detail["assessment"]["fields"]:
        if field["status"] != "present":
            continue
        if claims is not None and field["key"] not in claims:
            continue
        facts.append(
            {
                "id": f"fact_{field['key']}",
                "claim": field["key"],
                "value": field["evidence"][0]["excerpt"],
                "conditions": "环境零下7度" if field["key"] == "quantified_data" else "",
                "visibility": "public",
                "source_type": "file",
                "source_ref": field["evidence"][0]["file_id"],
            }
        )
    return facts


def _generate(client: TestClient, user_id: str, project_id: str, package: dict, products: list[str] | None = None) -> dict:
    response = client.post(
        f"/api/v1/projects/{project_id}/promotion-packages/{package['id']}/generate",
        headers=_headers(user_id),
        json={"expected_revision": package["revision"], "products": products or []},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _review(client: TestClient, user_id: str, project_id: str, package: dict, product: str, action: str) -> dict:
    state = package["products_state"][product]
    head = next(item for item in state["versions"] if item["output_id"] == state["head_output_id"])
    response = client.post(
        f"/api/v1/projects/{project_id}/promotion-packages/{package['id']}/reviews",
        headers=_headers(user_id),
        json={
            "expected_revision": package["revision"],
            "output_id": head["output_id"],
            "expected_version": head["version"],
            "action": action,
            "comment": "请补充口径" if action == "reject" else "",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def _approve_all(client: TestClient, user_id: str, project_id: str, package: dict, products: list[str]) -> dict:
    current = package
    for product in products:
        current = _review(client, user_id, project_id, current, product, "submit")
        current = _review(client, user_id, project_id, current, product, "approve")
    return current


def test_create_is_idempotent_and_isolated():
    owner = f"owner-{uuid.uuid4().hex[:8]}"
    other = f"other-{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        other_project = _create_project(client, other)
        file_id = _upload(client, owner, project_id, "spec.md", SPEC.encode(), "text/markdown")
        empty = client.get(
            f"/api/v1/projects/{other_project}/promotion-packages",
            headers=_headers(other),
        )
        assert empty.status_code == 200
        assert empty.json()["items"] == []
        key = uuid.uuid4().hex
        first = _create_package(client, owner, project_id, [file_id], key)
        second = _create_package(client, owner, project_id, [file_id], key)
        assert first["id"] == second["id"]
        assert second["replayed"] is True
        listed = client.get(
            f"/api/v1/projects/{project_id}/promotion-packages",
            headers=_headers(owner),
        )
        assert listed.status_code == 200
        assert [item["id"] for item in listed.json()["items"]].count(first["id"]) == 1
        denied = client.get(
            f"/api/v1/projects/{other_project}/promotion-packages/{first['id']}",
            headers=_headers(other),
        )
        assert denied.status_code == 404
        viewer = f"viewer-{uuid.uuid4().hex[:8]}"
        _add_member(client, owner, project_id, viewer, "viewer")
        forbidden = client.post(
            f"/api/v1/projects/{project_id}/promotion-packages",
            headers=_headers(viewer),
            json={"idempotency_key": uuid.uuid4().hex, "products": ["a4_skill"], "file_refs": [{"file_id": file_id, "kind": "attachment"}]},
        )
        assert forbidden.status_code == 404


def test_assess_shows_gap_conflict_and_trace(monkeypatch):
    seen: list[str] = []

    async def _search(query: str):
        seen.append(query)
        if "fail-once" in query:
            raise RuntimeError("down")
        return []

    monkeypatch.setattr("backend.services.promotion_package_service.public_search", _search)
    owner = f"owner-{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        good = _upload(client, owner, project_id, "spec.md", SPEC.replace("对比：公开资料约12分钟\n", "").encode(), "text/markdown")
        clash = _upload(client, owner, project_id, "clash.md", CONFLICT.encode(), "text/markdown")
        broken = _upload(client, owner, project_id, "broken.bin", b"\x00\x01", "application/octet-stream")
        package = _create_package(client, owner, project_id, [good, clash, broken])
        detail = _assess(client, owner, project_id, package)
        fields = {item["key"]: item for item in detail["assessment"]["fields"]}
        assert fields["quantified_data"]["status"] == "conflict"
        assert fields["comparison"]["status"] == "missing"
        assert fields["parse"]["status"] == "unreadable"
        assert "a4_skill" in fields["quantified_data"]["blocks"]
        assert fields["comparison"]["blocks"] == ["interview_qa_skill"]
        kb = next(item for item in detail["assessment"]["candidates"] if item["origin"] == "kb")
        web = next(item for item in detail["assessment"]["candidates"] if item["origin"] == "web")
        assert kb["source"]["doc_id"] == "kb-demo-1"
        assert kb["source"]["locator"] == "第2节"
        assert web["source"]["url"] == "https://example.com/public-competitor"
        assert all("8分钟" not in query for query in seen)
        again = client.get(
            f"/api/v1/projects/{project_id}/promotion-packages/{package['id']}",
            headers=_headers(owner),
        )
        assert again.status_code == 200
        assert again.json()["snapshot"]
        assert again.json()["assessment"]["fields"]


def test_missing_comparison_blocks_only_qa_and_metric_blocks_dependents():
    owner = f"owner-{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        no_compare = _upload(client, owner, project_id, "plain.md", SPEC_NO_COMPARE.encode(), "text/markdown")
        package = _create_package(client, owner, project_id, [no_compare])
        assessed = _assess(client, owner, project_id, package)
        confirmed = _confirm(client, owner, project_id, assessed, _file_facts(assessed), [])
        generated = _generate(client, owner, project_id, confirmed)
        assert generated["products_state"]["a4_skill"]["status"] == "draft"
        assert generated["products_state"]["tech_pr_skill"]["status"] == "draft"
        assert generated["products_state"]["interview_qa_skill"]["head_output_id"] == ""
        qa_step = next(step for step in generated["steps"] if step["step_key"] == "generate:interview_qa_skill")
        assert qa_step["status"] == "failed"
        assert qa_step["error_type"] == "blocked"

        project_metric = _create_project(client, owner)
        no_metric = _upload(client, owner, project_metric, "nometric.md", SPEC_NO_METRIC.encode(), "text/markdown")
        metric_package = _create_package(client, owner, project_metric, [no_metric])
        metric_assessed = _assess(client, owner, project_metric, metric_package)
        metric_confirmed = _confirm(client, owner, project_metric, metric_assessed, _file_facts(metric_assessed), [])
        metric_generated = _generate(client, owner, project_metric, metric_confirmed)
        assert metric_generated["products_state"]["interview_qa_skill"]["status"] == "draft"
        assert metric_generated["products_state"]["a4_skill"]["head_output_id"] == ""
        assert metric_generated["products_state"]["tech_pr_skill"]["head_output_id"] == ""


def test_generate_review_export_and_targeted_invalidation(monkeypatch):
    from backend.services import promotion_package_service as promotion

    calls = {"n": 0}
    original = promotion._run_skill

    async def flaky(product, context):
        if product == "tech_pr_skill" and calls["n"] == 0:
            calls["n"] += 1
            return {"content": "", "skill_version": "", "error_type": "RuntimeError", "elapsed_ms": 1}
        return await original(product, context)

    monkeypatch.setattr(promotion, "_run_skill", flaky)
    owner = f"owner-{uuid.uuid4().hex[:8]}"
    editor = f"editor-{uuid.uuid4().hex[:8]}"
    viewer = f"viewer-{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        _add_member(client, owner, project_id, editor, "editor")
        _add_member(client, owner, project_id, viewer, "viewer")
        file_id = _upload(client, owner, project_id, "spec.md", SPEC.encode(), "text/markdown")
        package = _create_package(client, editor, project_id, [file_id])
        assessed = _assess(client, editor, project_id, package)
        confirmed = _confirm(client, editor, project_id, assessed, _file_facts(assessed), [])
        failed = _generate(client, editor, project_id, confirmed)
        assert failed["products_state"]["a4_skill"]["status"] == "draft"
        assert failed["products_state"]["interview_qa_skill"]["status"] == "draft"
        assert failed["products_state"]["tech_pr_skill"]["head_output_id"] == ""
        retried = _generate(client, editor, project_id, failed)
        assert retried["products_state"]["tech_pr_skill"]["status"] == "draft"
        assert len(retried["products_state"]["a4_skill"]["versions"]) == 1
        again = _generate(client, editor, project_id, retried)
        assert len(again["products_state"]["a4_skill"]["versions"]) == 1
        denied = client.post(
            f"/api/v1/projects/{project_id}/promotion-packages/{again['id']}/reviews",
            headers=_headers(editor),
            json={
                "expected_revision": again["revision"],
                "output_id": again["products_state"]["a4_skill"]["head_output_id"],
                "expected_version": "1",
                "action": "approve",
            },
        )
        assert denied.status_code == 403
        approved = _approve_all(
            client,
            owner,
            project_id,
            again,
            ["a4_skill", "tech_pr_skill", "interview_qa_skill"],
        )
        pr = approved["products_state"]["tech_pr_skill"]
        head = next(item for item in pr["versions"] if item["output_id"] == pr["head_output_id"])
        revised = client.post(
            f"/api/v1/projects/{project_id}/promotion-packages/{approved['id']}/revise",
            headers=_headers(editor),
            json={
                "expected_revision": approved["revision"],
                "output_id": head["output_id"],
                "expected_version": head["version"],
                "content": head["content"].replace("技术升级", "技术升级（措辞调整）") + "\n措辞调整。\n",
                "fact_ids": head["fact_ids"],
            },
        )
        assert revised.status_code == 200, revised.text
        revised_body = revised.json()
        assert revised_body["products_state"]["a4_skill"]["status"] == "approved"
        assert revised_body["products_state"]["interview_qa_skill"]["status"] == "approved"
        assert revised_body["products_state"]["tech_pr_skill"]["status"] == "draft"
        a4_id = revised_body["products_state"]["a4_skill"]["head_output_id"]
        qa_id = revised_body["products_state"]["interview_qa_skill"]["head_output_id"]
        pr_id = revised_body["products_state"]["tech_pr_skill"]["head_output_id"]
        partial = client.post(
            f"/api/v1/projects/{project_id}/promotion-packages/{approved['id']}/export",
            headers=_headers(viewer),
            json={"output_ids": [a4_id, qa_id]},
        )
        assert partial.status_code == 200, partial.text
        archive = zipfile.ZipFile(io.BytesIO(partial.content))
        names = set(archive.namelist())
        assert names == {"A4技术一页纸.md", "采访QA.md", "manifest.json"}
        manifest = json.loads(archive.read("manifest.json"))
        assert len(manifest["items"]) == 2
        rejected = client.post(
            f"/api/v1/projects/{project_id}/promotion-packages/{approved['id']}/export",
            headers=_headers(viewer),
            json={"output_ids": [a4_id, pr_id]},
        )
        assert rejected.status_code == 409
        assert "export_conflict" in rejected.json()["detail"]
        assert rejected.headers["content-type"].startswith("application/json")

        changed = revised_body["facts"]
        for fact in changed:
            if fact["claim"] == "quantified_data":
                fact["value"] = "9分钟"
        updated = _confirm(client, editor, project_id, revised_body, changed, [])
        assert updated["products_state"]["a4_skill"]["status"] == "needs_rereview"
        assert updated["products_state"]["tech_pr_skill"]["versions"][0]["status"] == "needs_rereview"
        assert updated["products_state"]["interview_qa_skill"]["status"] == "approved"
        stale = client.post(
            f"/api/v1/projects/{project_id}/promotion-packages/{approved['id']}/export",
            headers=_headers(viewer),
            json={"output_ids": [a4_id]},
        )
        assert stale.status_code == 409
        assert "facts_changed" in stale.json()["detail"]
        assert not stale.headers["content-type"].startswith("application/zip")
        fresh = client.post(
            f"/api/v1/projects/{project_id}/promotion-packages/{approved['id']}/export",
            headers=_headers(viewer),
            json={"output_ids": [qa_id]},
        )
        assert fresh.status_code == 200, fresh.text


def test_expired_step_is_recovered_once():
    owner = f"owner-{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        file_id = _upload(client, owner, project_id, "spec.md", SPEC.encode(), "text/markdown")
        package = _create_package(client, owner, project_id, [file_id])
        assessed = _assess(client, owner, project_id, package)
        confirmed = _confirm(client, owner, project_id, assessed, _file_facts(assessed), [])

        async def _plant() -> None:
            async with async_session_maker() as db:
                db.add(
                    PromotionPackageStep(
                        id=str(uuid.uuid4()),
                        package_id=confirmed["id"],
                        project_id=project_id,
                        step_key="generate:a4_skill",
                        input_version=f"b{confirmed['brief_version']}-f{confirmed['facts_version']}",
                        status="running",
                        attempt=1,
                        worker_id="stale",
                        lease_until="2000-01-01T00:00:00",
                        created_at="2000-01-01T00:00:00",
                        updated_at="2000-01-01T00:00:00",
                    )
                )
                await db.commit()

        asyncio.run(_plant())
        generated = _generate(client, owner, project_id, confirmed)
        assert len(generated["products_state"]["a4_skill"]["versions"]) == 1
        repeated = _generate(client, owner, project_id, generated)
        assert len(repeated["products_state"]["a4_skill"]["versions"]) == 1


def test_promotion_package_mock_e2e(monkeypatch):
    """脱敏样例走完评估、采纳联网证据、生成、改稿、审核和选择性下载。"""

    async def _search(query: str):
        assert "8分钟" not in query
        return [
            {
                "claim": "comparison",
                "value": "公开竞品预热约12分钟",
                "url": "https://example.com/public-competitor",
            }
        ]

    monkeypatch.setattr("backend.services.promotion_package_service.public_search", _search)
    owner = f"owner-{uuid.uuid4().hex[:8]}"
    viewer = f"viewer-{uuid.uuid4().hex[:8]}"
    outsider = f"outsider-{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        other_project = _create_project(client, outsider)
        _add_member(client, owner, project_id, viewer, "viewer")
        file_id = _upload(client, owner, project_id, "spec.md", SPEC.encode(), "text/markdown")
        package = _create_package(client, owner, project_id, [file_id])
        assessed = _assess(client, owner, project_id, package)
        reopened = client.get(
            f"/api/v1/projects/{project_id}/promotion-packages/{package['id']}",
            headers=_headers(owner),
        )
        assert reopened.status_code == 200, reopened.text
        assert reopened.json()["snapshot"]
        web = next(
            item
            for item in assessed["assessment"]["candidates"]
            if item["origin"] == "web" and item["value"] == "公开竞品预热约12分钟"
        )
        assert web["source"]["url"] == "https://example.com/public-competitor"
        assert web["adopted"] is False
        facts = [item for item in _file_facts(assessed) if item["claim"] != "comparison"]
        facts.append(
            {
                "id": "fact_comparison_web",
                "claim": "comparison",
                "value": web["value"],
                "conditions": "",
                "visibility": "public",
                "source_type": "web",
                "source_ref": web["source"]["url"],
                "candidate_id": web["id"],
            }
        )
        confirmed = _confirm(client, owner, project_id, assessed, facts, [web["id"]])
        adopted = next(item for item in confirmed["facts"] if item["id"] == "fact_comparison_web")
        assert adopted["source_type"] == "web"
        assert adopted["confirmed_by"] == owner
        generated = _generate(client, owner, project_id, confirmed)
        for product in ("a4_skill", "tech_pr_skill", "interview_qa_skill"):
            assert generated["products_state"][product]["status"] == "draft"
            assert generated["products_state"][product]["head_output_id"]
        a4 = generated["products_state"]["a4_skill"]
        head = next(item for item in a4["versions"] if item["output_id"] == a4["head_output_id"])
        revised_text = head["content"].rstrip() + "\n补充公开口径。\n"
        revised = client.post(
            f"/api/v1/projects/{project_id}/promotion-packages/{generated['id']}/revise",
            headers=_headers(owner),
            json={
                "expected_revision": generated["revision"],
                "output_id": head["output_id"],
                "expected_version": head["version"],
                "content": revised_text,
                "fact_ids": head["fact_ids"],
            },
        )
        assert revised.status_code == 200, revised.text
        revised_body = revised.json()
        approved = _approve_all(
            client,
            owner,
            project_id,
            revised_body,
            ["a4_skill", "interview_qa_skill"],
        )
        assert approved["products_state"]["tech_pr_skill"]["status"] == "draft"
        a4_id = approved["products_state"]["a4_skill"]["head_output_id"]
        qa_id = approved["products_state"]["interview_qa_skill"]["head_output_id"]
        pr_id = approved["products_state"]["tech_pr_skill"]["head_output_id"]
        exported = client.post(
            f"/api/v1/projects/{project_id}/promotion-packages/{package['id']}/export",
            headers=_headers(viewer),
            json={"output_ids": [a4_id, qa_id]},
        )
        assert exported.status_code == 200, exported.text
        archive = zipfile.ZipFile(io.BytesIO(exported.content))
        assert set(archive.namelist()) == {"A4技术一页纸.md", "采访QA.md", "manifest.json"}
        assert "补充公开口径。" in archive.read("A4技术一页纸.md").decode("utf-8")
        manifest = json.loads(archive.read("manifest.json"))
        assert {item["output_id"] for item in manifest["items"]} == {a4_id, qa_id}
        unapproved = client.post(
            f"/api/v1/projects/{project_id}/promotion-packages/{package['id']}/export",
            headers=_headers(viewer),
            json={"output_ids": [pr_id, a4_id]},
        )
        assert unapproved.status_code == 409
        assert "not_approved" in unapproved.json()["detail"]
        assert unapproved.headers["content-type"].startswith("application/json")
        foreign = client.post(
            f"/api/v1/projects/{other_project}/promotion-packages/{package['id']}/export",
            headers=_headers(outsider),
            json={"output_ids": [a4_id, qa_id]},
        )
        assert foreign.status_code == 404
        kept = client.get(
            f"/api/v1/projects/{project_id}/promotion-packages/{package['id']}",
            headers=_headers(viewer),
        )
        assert kept.status_code == 200, kept.text
        assert kept.json()["products_state"]["a4_skill"]["status"] == "approved"
        assert kept.json()["facts"]


def test_wiki_compress_keeps_core_claims():
    from backend.services.promotion_quality import wiki_page

    page = wiki_page(
        [
            {"id": "f1", "claim": "tech_name", "value": "星海热管理", "visibility": "public", "source_type": "file", "source_ref": "spec.md"},
            {"id": "f2", "claim": "quantified_data", "value": "8分钟", "conditions": "零下7度", "visibility": "public", "source_type": "file"},
            {"id": "f3", "claim": "selling_points", "value": "待补充", "visibility": "public"},
        ],
        goal="对外介绍",
        audience="媒体",
    )
    assert page["type"] == "product"
    assert page["title"] == "星海热管理"
    ids = [item["id"] for item in page["claims"]]
    assert ids == ["f1", "f2"]
    metric = page["claims"][1]
    assert metric["conditions"] == "零下7度"
    assert metric["statement"] == "量化数据：8分钟"
    assert [section["heading"] for section in page["sections"]] == ["技术定义与定位", "核心指标"]


def test_fill_searches_project_kb_and_web(monkeypatch):
    calls = {"kb": 0, "web": 0}

    async def _kb(_project_id: str, query: str):
        calls["kb"] += 1
        assert "对比" in query
        return [{"value": "对比：知识库记录公开竞品约 12 分钟", "doc_id": "kb-1", "locator": "第3节"}]

    async def _web(query: str):
        calls["web"] += 1
        assert "8分钟" not in query
        return [{"value": "对比 公开报道预热约 12 分钟", "url": "https://example.com/warm"}]

    async def _public(_query: str):
        return []

    monkeypatch.setattr("backend.services.promotion_package_service.search_knowledge", _kb)
    monkeypatch.setattr("backend.services.promotion_package_service.search_web", _web)
    monkeypatch.setattr("backend.services.promotion_package_service.public_search", _public)
    owner = f"owner-{uuid.uuid4().hex[:8]}"
    body = """技术名称：星海热管理
用户与场景：冬季通勤预热
卖点：上车即暖
机理：热泵回收余热
量化数据：待补充
条件：环境零下7度
搭载范围：A级纯电
可公开口径：可对外发布舱温曲线
补充说明里提到对比公开竞品预热更慢
"""
    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        file_id = _upload(client, owner, project_id, "gap.md", body.encode(), "text/markdown")
        package = _create_package(client, owner, project_id, [file_id])
        response = client.post(
            f"/api/v1/projects/{project_id}/promotion-packages/{package['id']}/assess",
            headers=_headers(owner),
            json={"expected_revision": package["revision"], "fill": True},
        )
        assert response.status_code == 200, response.text
        detail = response.json()
        fields = {item["key"]: item for item in detail["assessment"]["fields"]}
        origins = {(item["origin"], item["claim"]) for item in detail["assessment"]["candidates"]}
        assert ("project", "comparison") in origins
        assert ("kb", "comparison") in origins
        assert ("web", "comparison") in origins
        assert fields["comparison"]["attention"] == "confirm"
        assert fields["quantified_data"]["attention"] == "fill"
        assert detail["assessment"]["fill"]["project"] >= 1
        assert detail["assessment"]["fill"]["kb"] >= 1
        assert detail["assessment"]["fill"]["web"] >= 1
        assert calls == {"kb": 1, "web": 1}


def test_complex_manuscripts_stay_out_of_promotion_and_drafts_save_to_project(monkeypatch):
    from backend.services import promotion_package_service as promotion
    from backend.services.promotion_quality import PRODUCTS

    for name in ("speech_skill", "speech_draft_skill", "video_skill", "video_script_skill"):
        assert name not in PRODUCTS

    async def fake_skill(product, context):
        return {"content": f"# {product}\n可保存正文", "skill_version": "test", "error_type": "", "elapsed_ms": 1}

    monkeypatch.setattr(promotion, "_run_skill", fake_skill)
    owner = f"owner-{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        project_id = _create_project(client, owner)
        file_id = _upload(client, owner, project_id, "spec.md", SPEC.encode(), "text/markdown")
        only_speech = client.post(
            f"/api/v1/projects/{project_id}/promotion-packages",
            headers=_headers(owner),
            json={
                "idempotency_key": uuid.uuid4().hex,
                "products": ["speech_skill", "video_script_skill"],
                "file_refs": [{"file_id": file_id, "kind": "attachment"}],
            },
        )
        assert only_speech.status_code == 400
        package = _create_package(client, owner, project_id, [file_id])
        assessed = _assess(client, owner, project_id, package)
        confirmed = _confirm(client, owner, project_id, assessed, _file_facts(assessed), [])
        generated = _generate(client, owner, project_id, confirmed, ["a4_skill", "speech_skill"])
        assert "speech_skill" not in generated["products_state"] or generated["products_state"].get("speech_skill", {}).get("head_output_id", "") == ""
        output_id = generated["products_state"]["a4_skill"]["head_output_id"]
        assert output_id
        saved = client.post(
            f"/api/v1/projects/{project_id}/promotion-packages/{generated['id']}/save-to-project",
            headers=_headers(owner),
            json={"output_ids": [output_id]},
        )
        assert saved.status_code == 200, saved.text
        body = saved.json()
        assert body["saved"] == 1
        assert body["files"][0]["title"] == "A4技术一页纸"
        again = client.post(
            f"/api/v1/projects/{project_id}/promotion-packages/{generated['id']}/save-to-project",
            headers=_headers(owner),
            json={"output_ids": [output_id]},
        )
        assert again.status_code == 200, again.text
        assert again.json()["files"][0]["id"] == body["files"][0]["id"]
        listed = client.get(f"/api/v1/projects/{project_id}/files", headers=_headers(owner))
        assert listed.status_code == 200
        matched = [item for item in listed.json()["items"] if item["title"] == "A4技术一页纸"]
        assert len(matched) == 1
        assert matched[0]["id"] == body["files"][0]["id"]
        assert matched[0]["session_id"] == body["session_id"]


def test_geo_card_is_discoverable_and_replaces_legacy_product():
    owner = f"owner-{uuid.uuid4().hex[:8]}"
    with TestClient(app) as client:
        workshop = client.get("/api/v1/ws/skills", headers=_headers(owner))
        assert workshop.status_code == 200, workshop.text
        assert "geo_card_skill" in workshop.json()["skills"]

        project_id = _create_project(client, owner)
        file_id = _upload(client, owner, project_id, "geo.md", SPEC.encode(), "text/markdown")
        response = client.post(
            f"/api/v1/projects/{project_id}/promotion-packages",
            headers=_headers(owner),
            json={
                "idempotency_key": uuid.uuid4().hex,
                "products": ["material_skill"],
                "file_refs": [{"file_id": file_id, "kind": "attachment"}],
            },
        )
        assert response.status_code == 200, response.text
        package = response.json()
        assert package["products"] == ["geo_card_skill"]
        facts = [
            {"claim": key, "value": value, "visibility": "public", "source_type": "human"}
            for key, value in {
                "tech_name": "测试技术",
                "audience_scene": "冬季通勤",
                "selling_points": "缩短预热时间",
                "public_wording": "指定工况下适用",
            }.items()
        ]
        facts.extend([
            {"claim": "quantified_data", "value": "8", "unit": "分钟", "conditions": "零下7度", "visibility": "public"},
            {"claim": "comparison", "value": "项目内部对比", "visibility": "project"},
        ])
        confirmed = _confirm(client, owner, project_id, package, facts, [])
        card = _generate(client, owner, project_id, confirmed)["products_state"]["geo_card_skill"]
        assert card["status"] == "draft"
        version = card["versions"][0]
        assert "8 分钟（适用条件：零下7度）" in version["content"]
        assert "项目内部对比" not in version["content"]
        assert len(version["fact_ids"]) == 5
