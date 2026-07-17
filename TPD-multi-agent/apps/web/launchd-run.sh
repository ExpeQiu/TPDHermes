#!/usr/bin/env bash
# 由 launchd 调用：工作目录与路径通过环境变量注入
set -euo pipefail
ROOT="${MULTI_AGENT_ROOT:?MULTI_AGENT_ROOT required}"
cd "$ROOT"
export MULTI_AGENT_RUNS_DIR="${MULTI_AGENT_RUNS_DIR:-$ROOT/runs}"
export MULTI_AGENT_WEB_PORT="${MULTI_AGENT_WEB_PORT:-8765}"
export MULTI_AGENT_WEB_HOST="${MULTI_AGENT_WEB_HOST:-127.0.0.1}"
PY="${MULTI_AGENT_PYTHON:-$ROOT/.venv/bin/python}"
if [[ ! -x "$PY" ]]; then
  python3 -m venv "$ROOT/.venv"
  PY="$ROOT/.venv/bin/python"
  "$PY" -m pip install -q -e "$ROOT"
fi
exec "$PY" "$ROOT/apps/web/app.py"
