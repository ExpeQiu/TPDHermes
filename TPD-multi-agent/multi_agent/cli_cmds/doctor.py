"""环境自检 doctor。"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Optional

import click

from multi_agent import __version__
from multi_agent.cli_cmds.common import common_output_options, emit, now_iso
from multi_agent.config import load_settings, redact_settings
from multi_agent.knowledge import list_knowledge_bases
from multi_agent.roles import list_role_ids
from multi_agent.skill_packs import list_packs
from multi_agent.skills import list_skill_ids
from multi_agent.trajectory import TrajectoryStore
from multi_agent.utils.errors import EXIT_OK


@click.command("doctor")
@common_output_options
def doctor(fmt: str, output: Optional[str], demo: bool) -> None:
    """环境自检：版本、配置摘要、资源计数、runs 目录。"""
    settings = load_settings(demo=True if demo else None)
    if demo:
        settings.mock_mode = True
    store = TrajectoryStore(settings.runs_dir)
    runs = store.list_runs()
    report = {
        "module": "doctor",
        "version": __version__,
        "data_source": settings.data_source,
        "fetched_at": now_iso(),
        "cli_version": __version__,
        "config": redact_settings(settings),
        "packs": len(list_packs()),
        "roles": len(list_role_ids()),
        "skills": len(list_skill_ids()),
        "knowledge_bases": len(list_knowledge_bases()),
        "runs_dir": str(Path(settings.runs_dir).resolve()),
        "runs_count": len(runs),
        "mock_mode": settings.mock_mode,
        "ok": True,
    }
    if fmt.lower() == "json":
        emit(json.dumps(report, ensure_ascii=False, indent=2), output)
    else:
        lines = [
            f"cli_version : {report['cli_version']}",
            f"mock_mode   : {report['mock_mode']}",
            f"packs       : {report['packs']}",
            f"roles       : {report['roles']}",
            f"skills      : {report['skills']}",
            f"knowledge   : {report['knowledge_bases']}",
            f"runs_dir    : {report['runs_dir']}",
            f"runs_count  : {report['runs_count']}",
            f"ok          : {report['ok']}",
        ]
        emit("\n".join(lines), output)
    sys.exit(EXIT_OK)
