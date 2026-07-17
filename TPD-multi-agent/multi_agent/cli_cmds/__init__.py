"""CLI 子命令分包：资源面 / doctor。"""

from __future__ import annotations

from multi_agent.cli_cmds.doctor import doctor
from multi_agent.cli_cmds.knowledge import knowledge
from multi_agent.cli_cmds.pack import pack
from multi_agent.cli_cmds.role import role
from multi_agent.cli_cmds.skill import skill


def register_extra(cli) -> None:
    """将资源组与 doctor 挂到主 cli。"""
    cli.add_command(pack)
    cli.add_command(role)
    cli.add_command(skill)
    cli.add_command(knowledge)
    cli.add_command(doctor)
