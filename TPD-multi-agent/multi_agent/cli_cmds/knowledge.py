"""Knowledge 命令组。"""

from __future__ import annotations

from typing import Optional

import click

from multi_agent.cli_cmds.common import common_output_options, exit_list
from multi_agent.knowledge import list_knowledge_bases


@click.group()
def knowledge() -> None:
    """知识库：list。"""


@knowledge.command("list")
@common_output_options
def knowledge_list(fmt: str, output: Optional[str], demo: bool) -> None:
    del demo
    exit_list(
        list_knowledge_bases(),
        "knowledge-list",
        fmt,
        output,
        columns=["id", "name", "kind", "available"],
    )
