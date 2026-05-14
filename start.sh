#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
export DATABASE_URL="${DATABASE_URL:-sqlite+aiosqlite:///./tphermes.db}"
export PYTHONPATH="$ROOT"
echo "[start] backend uvicorn :8000"
uvicorn main:app --host 0.0.0.0 --port 8000 &
echo $! >"$ROOT/.backend.pid"
echo "[start] frontend next dev :3000"
npm run dev &
echo $! >"$ROOT/.frontend.pid"
echo "[start] PIDs -> .backend.pid .frontend.pid (use stop.sh)"
