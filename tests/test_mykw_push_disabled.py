"""myKW push 默认关闭。"""

from pathlib import Path

from backend.services.mykw_kb_sync import MYKW_PUSH_REFUSED_REASON, push_to_hermes


def test_push_apply_refused_without_allow(tmp_path: Path):
    vault = tmp_path / "4.Knowledge"
    (vault / "02-知识库/吉利技术知识库").mkdir(parents=True)
    (vault / "02-知识库/吉利技术知识库/a.md").write_text("# A\n", encoding="utf-8")
    report = push_to_hermes(
        vault,
        chroma_url="http://localhost:9",
        output_dir=tmp_path / "out",
        apply=True,
        allow_push=False,
    )
    assert report["ok"] is False
    assert report["refused"] is True
    assert report["reason"] == MYKW_PUSH_REFUSED_REASON
    assert report["targets"] == []
