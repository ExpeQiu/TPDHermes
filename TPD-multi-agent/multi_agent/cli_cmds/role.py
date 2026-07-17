"""Role 命令组。"""

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
from multi_agent.roles import delete_role, list_roles_meta, load_role, save_role
from multi_agent.utils.errors import EXIT_OK, MultiAgentError


@click.group()
def role() -> None:
    """角色：list / show / save / delete。"""


@role.command("list")
@common_output_options
def role_list(fmt: str, output: Optional[str], demo: bool) -> None:
    del demo
    exit_list(
        list_roles_meta(),
        "role-list",
        fmt,
        output,
        columns=["id", "name", "kinds"],
    )


@role.command("show")
@click.argument("role_id")
@common_output_options
def role_show(role_id: str, fmt: str, output: Optional[str], demo: bool) -> None:
    del demo
    try:
        emit(format_object(load_role(role_id), fmt.lower()), output)
        sys.exit(EXIT_OK)
    except MultiAgentError as exc:
        fail(exc)


@role.command("save")
@click.option("--file", "file_path", required=True, type=click.Path(), help="YAML/JSON 载荷")
@click.option("--create", is_flag=True, help="仅创建；已存在则失败")
@common_output_options
def role_save(
    file_path: str, create: bool, fmt: str, output: Optional[str], demo: bool
) -> None:
    del demo
    try:
        payload = load_payload_file(file_path)
        if create:
            saved = save_role(payload, create=True)
        else:
            try:
                saved = save_role(payload, create=False)
            except MultiAgentError:
                saved = save_role(payload, create=True)
        emit(format_object(saved, fmt.lower()), output)
        sys.exit(EXIT_OK)
    except MultiAgentError as exc:
        fail(exc)


@role.command("delete")
@click.argument("role_id")
@click.option("--force", is_flag=True, help="确认删除")
@common_output_options
def role_delete(role_id: str, force: bool, fmt: str, output: Optional[str], demo: bool) -> None:
    del demo, fmt, output
    if not force:
        fail(MultiAgentError("删除 role 需要 --force"))
    try:
        delete_role(role_id)
        click.echo(f"已删除 role: {role_id}", err=True)
        sys.exit(EXIT_OK)
    except MultiAgentError as exc:
        fail(exc)
