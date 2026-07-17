#!/usr/bin/env bash
# stop.sh — bootout launchd + 清理端口
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
UID_NUM="$(id -u)"
LABEL_BE="com.tphermes.backend"
LABEL_FE="com.tphermes.frontend"

bootout_label() {
  local label="$1"
  if launchctl print "gui/${UID_NUM}/${label}" >/dev/null 2>&1; then
    echo "[stop] bootout ${label}"
    launchctl bootout "gui/${UID_NUM}/${label}" 2>/dev/null || true
  fi
}

bootout_label "$LABEL_FE"
bootout_label "$LABEL_BE"

for f in .backend.pid .frontend.pid; do
  if [[ -f "$ROOT/$f" ]]; then
    pid="$(cat "$ROOT/$f" 2>/dev/null || true)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "[stop] kill ${pid} (${f})"
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$ROOT/$f"
  fi
done

for port in 3000 8000; do
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "${pids:-}" ]]; then
    echo "[stop] kill listeners on :${port} -> ${pids}"
    # shellcheck disable=SC2086
    kill ${pids} 2>/dev/null || true
  fi
done

echo "[stop] done"
