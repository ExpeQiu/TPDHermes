"""tpdhermes 命令入口。数据走 stdout，说明走 stderr。"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from typing import Any

from tpdhermes import __version__
from tpdhermes.capabilities import (
    EXIT_ERROR,
    EXIT_OK,
    MODULES,
    invoke,
    public_config,
    save_document,
)

logger = logging.getLogger("tpdhermes.cli")


def _setup_logging(verbose: bool, quiet: bool) -> None:
    level = logging.WARNING if quiet else logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        stream=sys.stderr,
    )


def _emit(payload: dict[str, Any], fmt: str, output: str | None) -> None:
    if fmt == "json":
        text = json.dumps(payload, ensure_ascii=False, indent=2)
    elif fmt == "markdown":
        lines = [f"# {payload.get('module')} {payload.get('action')}", ""]
        for item in payload.get("items") or []:
            if isinstance(item, dict):
                title = item.get("name") or item.get("title") or item.get("id") or item.get("code")
                lines.append(f"- {title}")
            else:
                lines.append(f"- {item}")
        if payload.get("warnings"):
            lines.extend(["", "## warnings", *[f"- {w}" for w in payload["warnings"]]])
        text = "\n".join(lines)
    else:
        lines = [
            f"{payload.get('module')} {payload.get('action')}  count={payload.get('count')}  source={payload.get('data_source')}"
        ]
        for item in payload.get("items") or []:
            if isinstance(item, dict):
                bits = [
                    str(item.get(key))
                    for key in ("id", "name", "title", "code", "status", "enabled")
                    if item.get(key) is not None
                ]
                lines.append("  " + "  ".join(bits) if bits else "  " + json.dumps(item, ensure_ascii=False))
            else:
                lines.append(f"  {item}")
        for warning in payload.get("warnings") or []:
            print(warning, file=sys.stderr)
        text = "\n".join(lines)
    if output:
        with open(output, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.write("\n")
        print(f"已写入 {output}", file=sys.stderr)
    else:
        print(text)


def _add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--format", choices=["table", "json", "markdown"], default="table")
    parser.add_argument("-o", "--output", default=None)
    parser.add_argument("--demo", action="store_true", help="使用内置演示数据")
    parser.add_argument("--live", action="store_true", help="忽略模块的演示开关，访问 API")
    parser.add_argument("--user-id", default=None, help="覆盖配置中的 X-User-ID")
    parser.add_argument("--token", default=None, help="Agent 接入 Token，用于连接本系统并执行指令")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tpdhermes", description="TPDHermes 工作台 CLI")
    parser.add_argument("--version", action="version", version=f"tpdhermes {__version__}")
    parser.add_argument("-v", "--verbose", action="store_true")
    parser.add_argument("-q", "--quiet", action="store_true")
    sub = parser.add_subparsers(dest="group", required=True)

    config = sub.add_parser("config", help="查看或修改工作台 CLI 配置")
    config_sub = config.add_subparsers(dest="config_cmd", required=True)
    show = config_sub.add_parser("show", help="打印有效配置")
    _add_common(show)
    enable = config_sub.add_parser("enable", help="启用一个工作台 CLI")
    enable.add_argument("module", choices=[item["id"] for item in MODULES])
    disable = config_sub.add_parser("disable", help="关闭一个工作台 CLI")
    disable.add_argument("module", choices=[item["id"] for item in MODULES])
    set_cmd = config_sub.add_parser("set", help="写入 api-base、user-id 或模块默认值")
    set_cmd.add_argument("key", help="api-base、user-id，或 module.demo / module.default")
    set_cmd.add_argument("value", nargs="?", default="")
    set_cmd.add_argument("--default-key", default=None, help="配合 module.default 使用，如 project、collection、skill")

    for item in MODULES:
        group = sub.add_parser(item["command"], help=item["label"])
        actions = group.add_subparsers(dest="action", required=True)
        for action, spec in item["actions"].items():
            cmd = actions.add_parser(action, help=spec.get("label") or action)
            _add_common(cmd)
            requires = spec.get("requires") or []
            query_keys = set((spec.get("query") or {}).values())
            if "id" in requires or ("project" in requires and "id" not in requires):
                cmd.add_argument("id", nargs="?")
            if "name" in requires:
                cmd.add_argument("name", nargs="?")
            if "project" in requires or "project" in query_keys or item["default_key"] == "project":
                cmd.add_argument("--project", default=None)
            if "text" in requires or "text" in query_keys:
                cmd.add_argument("--text", default=None)
            if "collection" in requires or "collection" in query_keys or action in {"query", "query-all", "browse"}:
                cmd.add_argument("--collection", default=None)
            if "n" in requires or "n" in query_keys or action in {"query", "query-all"}:
                cmd.add_argument("-n", default=None)
            if "file" in requires:
                cmd.add_argument("--file", default=None)
            if "output" in requires:
                cmd.add_argument("--output-id", default=None)
            if "skill" in requires or (item["default_key"] == "skill" and "name" not in requires):
                cmd.add_argument("--skill", default=None)
            if "enabled" in requires:
                flag = cmd.add_mutually_exclusive_group()
                flag.add_argument("--on", action="store_true", help="启用")
                flag.add_argument("--off", action="store_true", help="停用")

    return parser


def _config_set(key: str, value: str, default_key: str | None) -> int:
    if key == "api-base":
        save_document({"api_base": value or None})
    elif key == "user-id":
        save_document({"user_id": value or None})
    elif key.endswith(".demo"):
        module_id = key[: -len(".demo")]
        if value not in {"true", "false", "inherit"}:
            print("demo 取值：true、false、inherit", file=sys.stderr)
            return EXIT_ERROR
        demo: bool | None = None if value == "inherit" else value == "true"
        save_document({"modules": {module_id: {"demo": demo}}})
    elif key.endswith(".default"):
        module_id = key[: -len(".default")]
        field = default_key
        if not field:
            print("设置默认值需要 --default-key", file=sys.stderr)
            return EXIT_ERROR
        save_document({"modules": {module_id: {"defaults": {field: value}}}})
    else:
        print("可设置 api-base、user-id、<module>.demo、<module>.default", file=sys.stderr)
        return EXIT_ERROR
    _emit(public_config(), "json", None)
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    _setup_logging(getattr(args, "verbose", False), getattr(args, "quiet", False))
    if args.group == "config":
        if args.config_cmd == "show":
            _emit(public_config(), args.format, args.output)
            return EXIT_OK
        if args.config_cmd == "enable":
            save_document({"modules": {args.module: {"enabled": True}}})
            _emit(public_config(), "json", None)
            return EXIT_OK
        if args.config_cmd == "disable":
            save_document({"modules": {args.module: {"enabled": False}}})
            _emit(public_config(), "json", None)
            return EXIT_OK
        return _config_set(args.key, args.value, args.default_key)

    module_id = next(item["id"] for item in MODULES if item["command"] == args.group)
    params = {
        "id": getattr(args, "id", None),
        "name": getattr(args, "name", None),
        "project": getattr(args, "project", None),
        "text": getattr(args, "text", None),
        "collection": getattr(args, "collection", None),
        "n": getattr(args, "n", None),
        "skill": getattr(args, "skill", None),
        "output": getattr(args, "output_id", None),
        "file": getattr(args, "file", None),
        "enabled": "true" if getattr(args, "on", False) else "false" if getattr(args, "off", False) else None,
    }
    code, payload = invoke(
        module_id,
        args.action,
        params,
        demo_flag=args.demo,
        live_flag=args.live,
        user_id=args.user_id,
        token=getattr(args, "token", None),
    )
    _emit(payload, args.format, args.output)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
