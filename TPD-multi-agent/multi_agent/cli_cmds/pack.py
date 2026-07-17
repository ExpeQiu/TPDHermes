"""Skill Pack 命令组。"""

from __future__ import annotations

import sys
from typing import Optional

import click

from multi_agent.cli_cmds.common import (
    common_output_options,
    emit,
    exit_list,
    fail,
    format_object,
    load_payload_file,
)
from multi_agent.skill_packs import list_packs_meta, load_pack, save_pack
from multi_agent.utils.errors import EXIT_OK, MultiAgentError


@click.group()
def pack() -> None:
    """Skill Pack：list / show / save。"""


@pack.command("list")
@common_output_options
def pack_list(fmt: str, output: Optional[str], demo: bool) -> None:
    del demo
    items = list_packs_meta()
    exit_list(
        items,
        "pack-list",
        fmt,
        output,
        columns=["id", "name", "roles", "experts"],
    )


@pack.command("show")
@click.argument("pack_id")
@common_output_options
def pack_show(pack_id: str, fmt: str, output: Optional[str], demo: bool) -> None:
    del demo
    try:
        data = load_pack(pack_id)
        clean = {k: v for k, v in data.items() if not str(k).startswith("_")}
        emit(format_object(clean, fmt.lower()), output)
        sys.exit(EXIT_OK)
    except MultiAgentError as exc:
        fail(exc)


@pack.command("save")
@click.option("--file", "file_path", required=True, type=click.Path(), help="YAML/JSON 载荷")
@click.option("--create", is_flag=True, help="仅创建；已存在则失败")
@common_output_options
def pack_save(
    file_path: str, create: bool, fmt: str, output: Optional[str], demo: bool
) -> None:
    del demo
    try:
        payload = load_payload_file(file_path)
        # 无 --create 时：不存在则创建，存在则更新
        if create:
            saved = save_pack(payload, create=True)
        else:
            try:
                saved = save_pack(payload, create=False)
            except MultiAgentError:
                saved = save_pack(payload, create=True)
        emit(format_object(saved, fmt.lower()), output)
        sys.exit(EXIT_OK)
    except MultiAgentError as exc:
        fail(exc)
