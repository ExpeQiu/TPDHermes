"""CLI 子命令共用：输出、信封、文件加载。"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import click
import yaml

from multi_agent import __version__
from multi_agent.utils.errors import EXIT_ERROR, EXIT_NO_DATA, EXIT_OK, MultiAgentError


def emit(data: str, output: Optional[str]) -> None:
    if output:
        Path(output).write_text(data, encoding="utf-8")
        click.echo(f"已写入 {output}", err=True)
    else:
        click.echo(data)


def common_output_options(fn):
    fn = click.option(
        "--format",
        "fmt",
        type=click.Choice(["table", "json", "markdown"], case_sensitive=False),
        default="table",
        show_default=True,
        help="输出格式",
    )(fn)
    fn = click.option("-o", "--output", type=click.Path(), default=None, help="写入文件")(fn)
    fn = click.option("--demo", is_flag=True, help="离线 Mock，不访问外网")(fn)
    return fn


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def list_envelope(module: str, items: list[Any], *, data_source: str = "live") -> dict[str, Any]:
    return {
        "module": module,
        "version": __version__,
        "data_source": data_source,
        "fetched_at": now_iso(),
        "count": len(items),
        "items": items,
    }


def format_list(envelope: dict[str, Any], fmt: str, *, columns: Optional[list[str]] = None) -> str:
    if fmt == "json":
        return json.dumps(envelope, ensure_ascii=False, indent=2)
    items = envelope.get("items") or []
    if not items:
        return "(empty)"
    if fmt == "markdown":
        keys = columns or list(items[0].keys())
        header = "| " + " | ".join(keys) + " |"
        sep = "| " + " | ".join("---" for _ in keys) + " |"
        rows = [
            "| " + " | ".join(str(it.get(k, "")) for k in keys) + " |" for it in items
        ]
        return "\n".join([header, sep, *rows])
    # table
    lines = []
    for it in items:
        if isinstance(it, dict):
            keys = columns or list(it.keys())
            lines.append("  ".join(f"{k}={it.get(k, '')}" for k in keys))
        else:
            lines.append(str(it))
    return "\n".join(lines)


def format_object(obj: dict[str, Any], fmt: str) -> str:
    if fmt == "json":
        return json.dumps(obj, ensure_ascii=False, indent=2)
    lines = [f"{k}: {v}" for k, v in obj.items() if not str(k).startswith("_")]
    return "\n".join(lines)


def load_payload_file(path: str) -> dict[str, Any]:
    p = Path(path)
    if not p.is_file():
        raise MultiAgentError(f"文件不存在: {path}")
    text = p.read_text(encoding="utf-8")
    if p.suffix.lower() == ".json":
        data = json.loads(text)
    else:
        data = yaml.safe_load(text)
    if not isinstance(data, dict):
        raise MultiAgentError("载荷须为 YAML/JSON 对象")
    return data


def load_text_file_or_stdin(path: Optional[str]) -> str:
    if path:
        p = Path(path)
        if not p.is_file():
            raise MultiAgentError(f"文件不存在: {path}")
        return p.read_text(encoding="utf-8")
    if sys.stdin.isatty():
        raise MultiAgentError("请提供 --file，或通过 stdin 传入内容")
    return sys.stdin.read()


def exit_list(items: list[Any], module: str, fmt: str, output: Optional[str], *, columns=None) -> None:
    env = list_envelope(module, items)
    emit(format_list(env, fmt.lower(), columns=columns), output)
    if not items:
        sys.exit(EXIT_NO_DATA)
    sys.exit(EXIT_OK)


def fail(exc: Exception, code: int = EXIT_ERROR) -> None:
    click.echo(str(exc), err=True)
    sys.exit(code)
