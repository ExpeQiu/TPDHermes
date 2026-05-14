#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
export DATABASE_URL="${DATABASE_URL:-sqlite+aiosqlite:///./tphermes.db}"
export PYTHONPATH="$ROOT"
HERMES_ENV_FILE="${HOME}/.hermes/.env"

if [[ -z "${HERMES_CHAT_API_KEY:-}" && -f "$HERMES_ENV_FILE" ]]; then
  hermes_api_key="$(python3 - "$HERMES_ENV_FILE" <<'PY'
from pathlib import Path
import sys

env_path = Path(sys.argv[1])
for raw in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    if line.startswith("export "):
        line = line[len("export "):]
    if line.startswith("API_SERVER_KEY="):
        print(line.split("=", 1)[1])
        break
PY
)"
  if [[ -n "${hermes_api_key:-}" ]]; then
    export HERMES_CHAT_API_KEY="$hermes_api_key"
    echo "[start] mapped HERMES_CHAT_API_KEY from $HERMES_ENV_FILE"
  fi
fi

echo "[start] backend uvicorn :8000"
uvicorn main:app --host 0.0.0.0 --port 8000 &
echo $! >"$ROOT/.backend.pid"
echo "[start] frontend next dev :3000"
npm run dev &
echo $! >"$ROOT/.frontend.pid"
echo "[start] PIDs -> .backend.pid .frontend.pid (use stop.sh)"
