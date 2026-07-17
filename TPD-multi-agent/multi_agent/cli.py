"""唯一 CLI 入口（Click）。"""

from __future__ import annotations

import json
import sys
from typing import Any, Optional

import click

from multi_agent import __version__
from multi_agent.config import ensure_user_config, load_settings, redact_settings
from multi_agent.coordinator import CoordinatorFacade
from multi_agent.llm import LLMClient
from multi_agent.modes import ConsultRuntime, RoundtableRuntime, SwarmRuntime
from multi_agent.trajectory import TrajectoryStore
from multi_agent.utils.errors import (
    EXIT_ERROR,
    EXIT_EXEC_FAIL,
    EXIT_INTERRUPT,
    EXIT_NO_DATA,
    EXIT_OK,
    ExecFailError,
    MultiAgentError,
    NoDeliveryError,
)
from multi_agent.utils.logger import get_logger, setup_logging
from multi_agent.cli_cmds import register_extra

logger = get_logger()


def _emit(data: str, output: Optional[str]) -> None:
    if output:
        with open(output, "w", encoding="utf-8") as f:
            f.write(data)
        click.echo(f"已写入 {output}", err=True)
    else:
        click.echo(data)


def _format_envelope(envelope: dict[str, Any], fmt: str) -> str:
    if fmt == "json":
        return json.dumps(envelope, ensure_ascii=False, indent=2)
    delivery = envelope.get("delivery") or {}
    body = delivery.get("body_markdown") or ""
    if fmt == "markdown":
        return body or json.dumps(envelope, ensure_ascii=False, indent=2)
    # table-ish human summary
    lines = [
        f"run_id     : {envelope.get('run_id')}",
        f"mode       : {envelope.get('mode')}",
        f"module     : {envelope.get('module')}",
        f"coordinator: {envelope.get('coordinator')}",
        f"data_source: {envelope.get('data_source')}",
        f"title      : {(delivery.get('title') or '')}",
        f"warnings   : {envelope.get('warnings') or []}",
        "",
        "--- delivery preview ---",
        (body[:500] + ("…" if len(body) > 500 else "")),
    ]
    return "\n".join(lines)


def _handle_result(envelope: dict[str, Any], fmt: str, output: Optional[str]) -> int:
    delivery = envelope.get("delivery") or {}
    if not delivery.get("body_markdown"):
        _emit(_format_envelope(envelope, fmt), output)
        return EXIT_NO_DATA
    _emit(_format_envelope(envelope, fmt), output)
    return EXIT_OK


class GlobalCtx:
    verbose: bool = False
    quiet: bool = False


pass_global = click.make_pass_decorator(GlobalCtx, ensure=True)


@click.group()
@click.version_option(__version__, prog_name="multi-agent")
@click.option("-v", "--verbose", is_flag=True, help="DEBUG 日志")
@click.option("-q", "--quiet", is_flag=True, help="仅 WARNING 及以上")
@click.pass_context
def cli(ctx: click.Context, verbose: bool, quiet: bool) -> None:
    """多模式 Agent 协作 CLI（圆桌 / Consult / Swarm）。"""
    setup_logging(verbose=verbose, quiet=quiet)
    g = GlobalCtx()
    g.verbose = verbose
    g.quiet = quiet
    ctx.obj = g


def _common_output_options(fn):
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


@cli.group()
def run() -> None:
    """运行态：start / list / status / resume / trajectory / export。"""


@run.command("list")
@_common_output_options
def run_list(fmt: str, output: Optional[str], demo: bool) -> None:
    """列出历史 runs 摘要。"""
    settings = load_settings(demo=demo if demo else None)
    store = TrajectoryStore(settings.runs_dir)
    items = store.list_runs()
    from multi_agent.cli_cmds.common import exit_list

    exit_list(
        items,
        "run-list",
        fmt,
        output,
        columns=["id", "mode", "status", "title"],
    )


@run.command("start")
@click.option("--goal", required=True, help="目标描述")
@click.option(
    "--mode",
    type=click.Choice(["auto", "roundtable", "consult", "swarm"], case_sensitive=False),
    default="auto",
    show_default=True,
)
@click.option("--pack", default=None, help="Skill Pack，默认 nev-tech")
@click.option("--rounds", default=2, show_default=True, type=int)
@click.option("--expert", default=None, help="Consult 限定专家 id")
@click.option("--max-parallel", default=None, type=int)
@click.option("--handoff-to-consult", is_flag=True, help="圆桌后 handoff 到 Consult")
@_common_output_options
def run_start(
    goal: str,
    mode: str,
    pack: Optional[str],
    rounds: int,
    expert: Optional[str],
    max_parallel: Optional[int],
    handoff_to_consult: bool,
    fmt: str,
    output: Optional[str],
    demo: bool,
) -> None:
    """统一入口（含 --mode auto）。"""
    settings = load_settings(demo=demo if demo else None, pack=pack, max_parallel=max_parallel)
    if demo:
        settings.mock_mode = True
    facade = CoordinatorFacade(settings)
    try:
        result = facade.run(
            goal,
            mode=mode.lower(),
            pack=pack,
            rounds=rounds,
            expert=expert,
            max_parallel=max_parallel,
            handoff_to_consult=handoff_to_consult,
        )
        code = _handle_result(result.to_envelope(), fmt.lower(), output)
        sys.exit(code)
    except NoDeliveryError as exc:
        click.echo(str(exc), err=True)
        sys.exit(EXIT_NO_DATA)
    except ExecFailError as exc:
        click.echo(str(exc), err=True)
        sys.exit(EXIT_EXEC_FAIL)
    except MultiAgentError as exc:
        click.echo(str(exc), err=True)
        sys.exit(EXIT_ERROR)


@run.command("status")
@click.argument("run_id")
@_common_output_options
def run_status(run_id: str, fmt: str, output: Optional[str], demo: bool) -> None:
    settings = load_settings(demo=demo if demo else None)
    store = TrajectoryStore(settings.runs_dir)
    state = store.load_state(run_id) or store.load_result(run_id)
    if not state:
        click.echo(f"找不到 run: {run_id}", err=True)
        sys.exit(EXIT_ERROR)
    if fmt.lower() == "json":
        _emit(json.dumps(state, ensure_ascii=False, indent=2), output)
    else:
        _emit(json.dumps(state, ensure_ascii=False, indent=2), output)
    sys.exit(EXIT_OK)


@run.command("trajectory")
@click.argument("run_id")
@_common_output_options
def run_trajectory(run_id: str, fmt: str, output: Optional[str], demo: bool) -> None:
    settings = load_settings(demo=demo if demo else None)
    store = TrajectoryStore(settings.runs_dir)
    text = store.load_trajectory(run_id)
    if not text:
        click.echo(f"无轨迹: {run_id}", err=True)
        sys.exit(EXIT_NO_DATA)
    if fmt.lower() == "json":
        _emit(json.dumps({"module": "run-trajectory", "run_id": run_id, "trajectory": text}, ensure_ascii=False, indent=2), output)
    else:
        _emit(text, output)
    sys.exit(EXIT_OK)


@run.command("resume")
@click.argument("run_id")
@_common_output_options
def run_resume(run_id: str, fmt: str, output: Optional[str], demo: bool) -> None:
    from multi_agent.sdk import create_client

    settings = load_settings(demo=demo if demo else None)
    if demo:
        settings.mock_mode = True
    client = create_client(
        demo=settings.mock_mode,
        runs_dir=settings.runs_dir,
    )
    try:
        envelope = client.resume(run_id)
        code = _handle_result(envelope, fmt.lower(), output)
        sys.exit(code)
    except MultiAgentError as exc:
        click.echo(str(exc), err=True)
        sys.exit(EXIT_ERROR)


@run.command("export")
@click.argument("run_id")
@click.option(
    "--what",
    type=click.Choice(["delivery", "trajectory", "bundle"], case_sensitive=False),
    default="delivery",
    show_default=True,
    help="导出内容",
)
@_common_output_options
def run_export(
    run_id: str, what: str, fmt: str, output: Optional[str], demo: bool
) -> None:
    """导出 delivery / trajectory / 完整 bundle。"""
    settings = load_settings(demo=demo if demo else None)
    store = TrajectoryStore(settings.runs_dir)
    bundle = store.load_bundle(run_id)
    if not bundle:
        click.echo(f"找不到 run: {run_id}", err=True)
        sys.exit(EXIT_ERROR)
    what_l = what.lower()
    if what_l == "delivery":
        body = bundle.get("delivery") or ""
        if not body:
            click.echo(f"无交付正文: {run_id}", err=True)
            sys.exit(EXIT_NO_DATA)
        if fmt.lower() == "json":
            _emit(
                json.dumps(
                    {
                        "module": "run-export",
                        "run_id": run_id,
                        "what": "delivery",
                        "body": body,
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                output,
            )
        else:
            _emit(body, output)
        sys.exit(EXIT_OK)
    if what_l == "trajectory":
        text = bundle.get("trajectory") or ""
        if not text:
            click.echo(f"无轨迹: {run_id}", err=True)
            sys.exit(EXIT_NO_DATA)
        if fmt.lower() == "json":
            _emit(
                json.dumps(
                    {
                        "module": "run-export",
                        "run_id": run_id,
                        "what": "trajectory",
                        "trajectory": text,
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                output,
            )
        else:
            _emit(text, output)
        sys.exit(EXIT_OK)
    payload = {
        "module": "run-export",
        "run_id": run_id,
        "what": "bundle",
        **bundle,
    }
    if fmt.lower() == "markdown":
        parts = [
            f"# export {run_id}",
            "",
            "## delivery",
            "",
            bundle.get("delivery") or "",
            "",
            "## trajectory",
            "",
            bundle.get("trajectory") or "",
        ]
        _emit("\n".join(parts), output)
    else:
        _emit(json.dumps(payload, ensure_ascii=False, indent=2), output)
    sys.exit(EXIT_OK)


@cli.group()
def mode() -> None:
    """显式模式：roundtable / consult / swarm。"""


@mode.command("roundtable")
@click.option("--topic", required=True)
@click.option("--pack", default="nev-tech", show_default=True)
@click.option("--rounds", default=2, show_default=True, type=int)
@click.option(
    "--discussion-mode",
    "discussion_mode",
    default="round_robin",
    show_default=True,
    type=click.Choice(["round_robin", "parallel", "debate"], case_sensitive=False),
)
@click.option("--consensus/--no-consensus", default=False, show_default=True)
@click.option("--consensus-threshold", default=0.7, show_default=True, type=float)
@_common_output_options
def mode_roundtable(
    topic: str,
    pack: str,
    rounds: int,
    discussion_mode: str,
    consensus: bool,
    consensus_threshold: float,
    fmt: str,
    output: Optional[str],
    demo: bool,
) -> None:
    settings = load_settings(demo=True if demo else None, pack=pack)
    if demo:
        settings.mock_mode = True
    rt = RoundtableRuntime(settings, TrajectoryStore(settings.runs_dir), LLMClient(settings))
    try:
        result = rt.run(
            topic,
            pack=pack,
            rounds=rounds,
            discussion_mode=discussion_mode,
            consensus_enabled=consensus,
            consensus_threshold=consensus_threshold,
        )
        sys.exit(_handle_result(result.to_envelope(), fmt.lower(), output))
    except NoDeliveryError as exc:
        click.echo(str(exc), err=True)
        sys.exit(EXIT_NO_DATA)
    except ExecFailError as exc:
        click.echo(str(exc), err=True)
        sys.exit(EXIT_EXEC_FAIL)


@mode.command("consult")
@click.option("--goal", required=True)
@click.option("--pack", default="nev-tech", show_default=True)
@click.option("--expert", default=None)
@_common_output_options
def mode_consult(
    goal: str, pack: str, expert: Optional[str], fmt: str, output: Optional[str], demo: bool
) -> None:
    settings = load_settings(demo=True if demo else None, pack=pack)
    if demo:
        settings.mock_mode = True
    rt = ConsultRuntime(settings, TrajectoryStore(settings.runs_dir), LLMClient(settings))
    try:
        result = rt.run(goal, pack=pack, expert=expert)
        sys.exit(_handle_result(result.to_envelope(), fmt.lower(), output))
    except NoDeliveryError as exc:
        click.echo(str(exc), err=True)
        sys.exit(EXIT_NO_DATA)
    except ExecFailError as exc:
        click.echo(str(exc), err=True)
        sys.exit(EXIT_EXEC_FAIL)


@mode.command("swarm")
@click.option("--goal", required=True)
@click.option("--pack", default="nev-tech", show_default=True)
@click.option("--max-parallel", default=5, show_default=True, type=int)
@_common_output_options
def mode_swarm(
    goal: str,
    pack: str,
    max_parallel: int,
    fmt: str,
    output: Optional[str],
    demo: bool,
) -> None:
    settings = load_settings(demo=True if demo else None, pack=pack, max_parallel=max_parallel)
    if demo:
        settings.mock_mode = True
    rt = SwarmRuntime(settings, TrajectoryStore(settings.runs_dir), LLMClient(settings))
    try:
        result = rt.run(goal, pack=pack, max_parallel=max_parallel)
        sys.exit(_handle_result(result.to_envelope(), fmt.lower(), output))
    except NoDeliveryError as exc:
        click.echo(str(exc), err=True)
        sys.exit(EXIT_NO_DATA)
    except ExecFailError as exc:
        click.echo(str(exc), err=True)
        sys.exit(EXIT_EXEC_FAIL)


@cli.group()
def config() -> None:
    """配置：init / show。"""


@config.command("init")
def config_init() -> None:
    path = ensure_user_config()
    click.echo(f"已初始化 {path}", err=True)
    click.echo(str(path))
    sys.exit(EXIT_OK)


@config.command("show")
@_common_output_options
def config_show(fmt: str, output: Optional[str], demo: bool) -> None:
    settings = load_settings(demo=True if demo else None)
    data = redact_settings(settings)
    if fmt.lower() == "json":
        _emit(json.dumps(data, ensure_ascii=False, indent=2), output)
    else:
        lines = [f"{k}: {v}" for k, v in data.items()]
        _emit("\n".join(lines), output)
    sys.exit(EXIT_OK)


register_extra(cli)


def main() -> None:
    try:
        cli(standalone_mode=True)
    except SystemExit:
        raise
    except KeyboardInterrupt:
        click.echo("已中断", err=True)
        sys.exit(EXIT_INTERRUPT)
    except Exception as exc:  # noqa: BLE001
        click.echo(f"未捕获异常: {exc}", err=True)
        sys.exit(EXIT_ERROR)


if __name__ == "__main__":
    main()