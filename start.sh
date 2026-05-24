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

mkdir -p "$ROOT/logs"
if [[ -f "$ROOT/.env.local" ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$line" == export\ * ]]; then
      line="${line#export }"
    fi
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      val="${BASH_REMATCH[2]}"
      if [[ "$val" == \"*\" && "$val" == *\" ]]; then
        val="${val:1:${#val}-2}"
      elif [[ "$val" == \'*\' && "$val" == *\' ]]; then
        val="${val:1:${#val}-2}"
      fi
      export "$key=$val"
    fi
  done <"$ROOT/.env.local"
fi
export HERMES_CHAT_API_URL="${HERMES_CHAT_API_URL:-http://127.0.0.1:8642/v1/chat/completions}"
export HERMES_CHAT_API_KEY="${HERMES_CHAT_API_KEY:-${API_SERVER_KEY:-}}"
export KB_EMBED_CACHE_DIR="${KB_EMBED_CACHE_DIR:-$ROOT/.cache/huggingface}"
export HF_HOME="${HF_HOME:-$KB_EMBED_CACHE_DIR}"
export HUGGINGFACE_HUB_CACHE="${HUGGINGFACE_HUB_CACHE:-$KB_EMBED_CACHE_DIR/hub}"
export TRANSFORMERS_CACHE="${TRANSFORMERS_CACHE:-$KB_EMBED_CACHE_DIR/transformers}"
export SENTENCE_TRANSFORMERS_HOME="${SENTENCE_TRANSFORMERS_HOME:-$KB_EMBED_CACHE_DIR/sentence_transformers}"
mkdir -p "$KB_EMBED_CACHE_DIR" "$HUGGINGFACE_HUB_CACHE" "$TRANSFORMERS_CACHE" "$SENTENCE_TRANSFORMERS_HOME"
echo "[start] KB embedding cache dir: $KB_EMBED_CACHE_DIR"
if [[ -f "$ROOT/.venv/bin/pip" && -f "$ROOT/requirements.txt" ]]; then
  echo "[start] sync python deps (requirements.txt)"
  "$ROOT/.venv/bin/pip" install -q -r "$ROOT/requirements.txt"
fi
echo "[start] backend uvicorn :8000"
"$ROOT/.venv/bin/uvicorn" main:app --host 127.0.0.1 --port 8000 >>"$ROOT/logs/backend.log" 2>&1 &
echo $! >"$ROOT/.backend.pid"
echo "[start] frontend next dev :3000"
npm run dev >>"$ROOT/logs/frontend.log" 2>&1 &
echo $! >"$ROOT/.frontend.pid"
echo "[start] PIDs -> .backend.pid .frontend.pid (use stop.sh)"
