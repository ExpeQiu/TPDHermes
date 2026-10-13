"""
经 GeelyWiki CLI 拉取知识更新（list/get/export），不直读 dist/pages.json。

默认：
  node $GEELYWIKI_ROOT/bin/geelywiki.mjs pages export --format json
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

logger = logging.getLogger("tpdx.hermes.geelywiki_cli")

DEFAULT_GEELYWIKI_ROOT = Path("/Volumes/Lexar/git/03T/GeelyWiki")
CLI_TIMEOUT_SEC = 90


class GeelyWikiCliError(RuntimeError):
    def __init__(self, message: str, *, exit_code: int | None = None, stderr: str = ""):
        super().__init__(message)
        self.exit_code = exit_code
        self.stderr = stderr


def geelywiki_root(explicit: str | None = None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    env = (os.getenv("GEELYWIKI_ROOT") or "").strip()
    if env:
        return Path(env).expanduser().resolve()
    return DEFAULT_GEELYWIKI_ROOT


def geelywiki_cli_argv(root: Path | None = None) -> list[str]:
    override = (os.getenv("GEELYWIKI_CLI") or "").strip()
    if override:
        return override.split()
    wiki = root or geelywiki_root()
    bin_path = wiki / "bin" / "geelywiki.mjs"
    node = shutil.which("node") or "node"
    return [node, str(bin_path)]


def run_geelywiki_cli(
    args: list[str],
    *,
    demo: bool = False,
    timeout: float = CLI_TIMEOUT_SEC,
    root: Path | None = None,
) -> dict[str, Any]:
    wiki = root or geelywiki_root()
    cmd = [*geelywiki_cli_argv(wiki), "--format", "json", "-q"]
    if demo:
        cmd.append("--demo")
    cmd.extend(args)
    logger.info("geelywiki cli cmd=%s demo=%s cwd=%s", " ".join(cmd[-4:]), demo, wiki)
    # Python 3.14 + PIPE 在 ~64KB 截断 stdout（live export ~192KB），落到文件再读。
    stdout_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix="geelywiki-cli-",
            suffix=".json",
            delete=False,
        ) as tmp:
            stdout_path = Path(tmp.name)
        try:
            with stdout_path.open("wb") as stdout_f:
                proc = subprocess.run(
                    cmd,
                    cwd=str(wiki),
                    stdout=stdout_f,
                    stderr=subprocess.PIPE,
                    timeout=timeout,
                    check=False,
                )
        except FileNotFoundError as exc:
            raise GeelyWikiCliError(f"无法执行 GeelyWiki CLI: {exc}") from exc
        except subprocess.TimeoutExpired as exc:
            raise GeelyWikiCliError(f"GeelyWiki CLI 超时: {args}") from exc
        raw = stdout_path.read_bytes()
        stderr = (proc.stderr or b"").decode("utf-8", errors="replace")
        logger.info(
            "geelywiki cli stdout_bytes=%s exit=%s demo=%s",
            len(raw),
            proc.returncode,
            demo,
        )
    finally:
        if stdout_path is not None:
            stdout_path.unlink(missing_ok=True)
    if proc.returncode not in (0, 2):
        raise GeelyWikiCliError(
            f"GeelyWiki CLI 失败 exit={proc.returncode} args={args}",
            exit_code=proc.returncode,
            stderr=stderr[-800:],
        )
    try:
        stdout = raw.decode("utf-8").strip()
    except UnicodeDecodeError as exc:
        raise GeelyWikiCliError(f"GeelyWiki CLI 非 UTF-8: {exc}") from exc
    if not stdout:
        if proc.returncode == 2:
            return {"module": "empty", "pages": [], "items": [], "count": 0}
        raise GeelyWikiCliError("GeelyWiki CLI 空输出", exit_code=proc.returncode)
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise GeelyWikiCliError(f"GeelyWiki CLI 非 JSON: {stdout[:200]}") from exc
    if not isinstance(payload, dict):
        raise GeelyWikiCliError("GeelyWiki CLI JSON 必须是对象")
    payload["_exit_code"] = proc.returncode
    return payload


def fetch_pages_via_cli(
    *,
    demo: bool = False,
    root: Path | None = None,
) -> dict[str, Any]:
    """优先 pages export；失败则 list + get。正文与 claims 必须齐全。"""
    try:
        exported = run_geelywiki_cli(["pages", "export"], demo=demo, root=root)
    except GeelyWikiCliError as exc:
        logger.warning("pages export 不可用，回退 list+get: %s", exc)
        exported = None
    if exported and exported.get("module") == "pages-export":
        pages = [p for p in (exported.get("pages") or []) if isinstance(p, dict)]
        missing_body = [p.get("slug") for p in pages if not str(p.get("body") or "").strip()]
        if missing_body:
            logger.warning("geelywiki export 缺正文 slugs=%s", missing_body[:8])
        logger.info(
            "geelywiki cli export count=%s source=%s fetched_at=%s",
            len(pages),
            exported.get("data_source"),
            exported.get("fetched_at"),
        )
        return {
            "publish_scope": exported.get("publish_scope") or "internal",
            "data_source": exported.get("data_source") or ("demo" if demo else "cli"),
            "fetched_at": exported.get("fetched_at"),
            "pages": pages,
        }

    listed = run_geelywiki_cli(["pages", "list"], demo=demo, root=root)
    items = listed.get("items") or []
    pages: list[dict[str, Any]] = []
    for row in items:
        if not isinstance(row, dict):
            continue
        slug = str(row.get("slug") or "").strip()
        if not slug:
            continue
        got = run_geelywiki_cli(["pages", "get", slug], demo=demo, root=root)
        item = got.get("item") if isinstance(got.get("item"), dict) else None
        if item and str(item.get("body") or "").strip():
            pages.append(item)
        else:
            logger.warning("geelywiki pages get 缺正文 slug=%s", slug)
    logger.info("geelywiki cli list+get count=%s", len(pages))
    return {
        "publish_scope": "internal",
        "data_source": listed.get("data_source") or ("demo" if demo else "cli"),
        "fetched_at": listed.get("fetched_at"),
        "pages": pages,
    }
