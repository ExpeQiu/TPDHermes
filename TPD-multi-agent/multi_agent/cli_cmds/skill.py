"""Skill 命令组。"""

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
    load_text_file_or_stdin,
)
from multi_agent.skills import (
    delete_skill,
    import_skill_markdown,
    list_skills_meta,
    load_skill,
    save_skill,
)
from multi_agent.utils.errors import EXIT_OK, MultiAgentError


@click.group()
def skill() -> None:
    """Skills：list / show / save / import / delete。"""


@skill.command("list")
@common_output_options
def skill_list(fmt: str, output: Optional[str], demo: bool) -> None:
    del demo
    exit_list(
        list_skills_meta(),
        "skill-list",
        fmt,
        output,
        columns=["id", "name", "kind", "runtime", "enabled"],
    )


@skill.command("show")
@click.argument("skill_id")
@common_output_options
def skill_show(skill_id: str, fmt: str, output: Optional[str], demo: bool) -> None:
    del demo
    try:
        emit(format_object(load_skill(skill_id), fmt.lower()), output)
        sys.exit(EXIT_OK)
    except MultiAgentError as exc:
        fail(exc)


@skill.command("save")
@click.option("--file", "file_path", required=True, type=click.Path(), help="YAML/JSON 载荷")
@click.option("--create", is_flag=True, help="仅创建；已存在则失败")
@common_output_options
def skill_save(
    file_path: str, create: bool, fmt: str, output: Optional[str], demo: bool
) -> None:
    del demo
    try:
        payload = load_payload_file(file_path)
        if create:
            saved = save_skill(payload, create=True)
        else:
            try:
                saved = save_skill(payload, create=False)
            except MultiAgentError:
                saved = save_skill(payload, create=True)
        emit(format_object(saved, fmt.lower()), output)
        sys.exit(EXIT_OK)
    except MultiAgentError as exc:
        fail(exc)


@skill.command("import")
@click.option("--file", "file_path", default=None, type=click.Path(), help="SKILL.md；省略则读 stdin")
@click.option("--source", default="cli-import", show_default=True, help="来源标记")
@common_output_options
def skill_import(
    file_path: Optional[str],
    source: str,
    fmt: str,
    output: Optional[str],
    demo: bool,
) -> None:
    del demo
    try:
        text = load_text_file_or_stdin(file_path)
        saved = import_skill_markdown(text, source=source)
        emit(format_object(saved, fmt.lower()), output)
        sys.exit(EXIT_OK)
    except MultiAgentError as exc:
        fail(exc)


@skill.command("delete")
@click.argument("skill_id")
@click.option("--force", is_flag=True, help="确认删除")
@common_output_options
def skill_delete(
    skill_id: str, force: bool, fmt: str, output: Optional[str], demo: bool
) -> None:
    del demo, fmt, output
    if not force:
        fail(MultiAgentError("删除 skill 需要 --force"))
    try:
        delete_skill(skill_id)
        click.echo(f"已删除 skill: {skill_id}", err=True)
        sys.exit(EXIT_OK)
    except MultiAgentError as exc:
        fail(exc)
