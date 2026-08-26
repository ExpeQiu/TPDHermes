"""myKW ↔ TPDHermes 双向同步契约测试。"""

from __future__ import annotations

import json
from pathlib import Path

from backend.services.mykw_kb_sync import (
    BLOCKED_COLLECTIONS,
    PULL_ROOT,
    TARGETS,
    collection_allowed,
    group_chunks_by_doc,
    is_hermes_owned,
    list_target_documents,
    pull_dest_path,
    read_note_checksum,
    reconstruct_markdown,
    render_pulled_note,
    status_report,
)


def test_targets_use_post_move_mykw_paths():
    dirs = {t.relative_dir for t in TARGETS}
    assert "01-汽车信息库/车企战略" not in dirs
    assert "01-汽车信息库/车型库" not in dirs
    assert "02-知识库/吉利技术知识库" in dirs
    assert "02-知识库/吉利技术档案" in dirs
    assert "03-发布成果" in dirs
    assert "04-车企战略" in dirs


def test_official_tech_pushes_to_authoritative_collection():
    tech = next(t for t in TARGETS if t.name == "jlgf_tech_points")
    assert tech.collection == "internal.structured_tech.tech_points"
    assert tech.domain == "structured_tech"
    speeches = next(t for t in TARGETS if t.name == "release_speeches")
    assert speeches.collection == "public.release_assets.speeches"


def test_block_internet_and_project_collections():
    assert "public.structured_tech.geely_tech" in BLOCKED_COLLECTIONS
    assert not collection_allowed("public.structured_tech.geely_tech")
    assert not collection_allowed("project.abc.kb")
    assert collection_allowed("internal.structured_tech.tech_points")


def test_hermes_owned_does_not_include_obsidian_import():
    assert is_hermes_owned({"source": "conversation_harvest", "source_type": "conversation_harvest"})
    assert is_hermes_owned({"source": "manual_entry", "source_type": "manual"})
    assert not is_hermes_owned({"source": "obsidian_import", "source_type": "file"})
    assert not is_hermes_owned({"source": "web_retrieval", "source_type": "web"})


def test_reconstruct_and_pull_path(tmp_path: Path):
    data = {
        "ids": ["d1_chunk_0002", "d1_chunk_0001"],
        "documents": ["## 后段", "# 标题\n前段"],
        "metadatas": [
            {"doc_id": "d1", "chunk_index": 2, "source": "manual"},
            {"doc_id": "d1", "chunk_index": 1, "source": "manual", "title": "标题"},
        ],
    }
    grouped = group_chunks_by_doc(data)
    body = reconstruct_markdown(grouped["d1"]["chunks"])
    assert body.startswith("# 标题")
    assert "后段" in body
    dest = pull_dest_path(tmp_path, "internal.structured_tech.tech_points", "d1")
    assert PULL_ROOT in dest.as_posix()
    assert dest.name == "d1.md"


def test_render_pulled_note_checksum_roundtrip(tmp_path: Path):
    note = render_pulled_note(
        doc_id="harvest_abc",
        collection="internal.structured_tech.tech_points",
        body="正文",
        meta={"title": "收割", "source": "hermes_chat", "source_type": "conversation_harvest"},
        checksum="sha256:deadbeef",
        synced_at="2026-08-26T02:00:00+00:00",
    )
    path = tmp_path / "n.md"
    path.write_text(note, encoding="utf-8")
    assert read_note_checksum(path) == "sha256:deadbeef"
    assert "hermes_sync" in note


def test_list_target_documents_skips_missing_and_reads_md(tmp_path: Path):
    vault = tmp_path / "4.Knowledge"
    tech = vault / "02-知识库/吉利技术知识库"
    tech.mkdir(parents=True)
    (tech / "JLGF.md").write_text("# JLGF\n参数\n", encoding="utf-8")
    target = next(t for t in TARGETS if t.name == "jlgf_tech_points")
    docs = list_target_documents(vault, target)
    assert len(docs) == 1
    assert docs[0]["title"] == "吉利核心技术信息参考（JLGF）"
    missing = next(t for t in TARGETS if t.name == "release_speeches")
    assert list_target_documents(vault, missing) == []


def test_status_report_without_chroma(tmp_path: Path):
    vault = tmp_path / "4.Knowledge"
    (vault / "02-知识库/吉利技术知识库").mkdir(parents=True)
    (vault / "02-知识库/吉利技术知识库/a.md").write_text("# A\n", encoding="utf-8")
    report = status_report(vault)
    assert report["direction"] == "status"
    names = {x["name"]: x for x in report["push"]}
    assert names["jlgf_tech_points"]["md_count"] == 1
    assert names["release_speeches"]["dir_exists"] is False
    assert report["pull"]["chroma_reachable"] is False
    json.dumps(report)


def test_pull_writes_only_hermes_owned(tmp_path: Path, monkeypatch):
    from backend.services import mykw_kb_sync as svc

    class FakeClient:
        def heartbeat(self) -> bool:
            return True

        def collection_names(self) -> list[str]:
            return ["internal.structured_tech.tech_points", "project.x.kb"]

        def get_by_where(self, collection, where, limit=100_000, offset=0, include=None):
            return {
                "ids": ["h1_chunk_0001", "o1_chunk_0001"],
                "documents": ["收割正文", "官方正文"],
                "metadatas": [
                    {
                        "doc_id": "h1",
                        "chunk_index": 1,
                        "source": "hermes_chat",
                        "source_type": "conversation_harvest",
                        "title": "收割",
                        "checksum": "sha256:h1",
                    },
                    {
                        "doc_id": "o1",
                        "chunk_index": 1,
                        "source": "obsidian_import",
                        "source_type": "file",
                        "title": "官方",
                    },
                ],
            }

    monkeypatch.setattr(svc, "ChromaHttpClient", lambda url: FakeClient())
    vault = tmp_path / "vault"
    vault.mkdir()
    report = svc.pull_from_hermes(vault, chroma_url="http://chroma", apply=True)
    assert report["ok"] is True
    assert len(report["written"]) == 1
    assert report["written"][0]["doc_id"] == "h1"
    dest = Path(report["written"][0]["path"])
    assert dest.is_file()
    assert PULL_ROOT in dest.as_posix()
    assert "收割正文" in dest.read_text(encoding="utf-8")

