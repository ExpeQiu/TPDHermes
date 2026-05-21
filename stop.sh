#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
for f in .backend.pid .frontend.pid; do
  if [[ -f "$ROOT/$f" ]]; then
    pid="$(cat "$ROOT/$f")"
    if kill -0 "$pid" 2>/dev/null; then
      echo "[stop] kill $pid ($f)"
      kill "$pid" || true
    fi
    rm -f "$ROOT/$f"
  fi
done
# 清理可能残留的 next dev / uvicorn 子进程（避免端口占用与 500）
for port in 3000 8000; do
  pids="$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "${pids:-}" ]]; then
    echo "[stop] kill listeners on :$port -> $pids"
    kill $pids 2>/dev/null || true
  fi
done
echo "[stop] done"
