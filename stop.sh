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
echo "[stop] done"
