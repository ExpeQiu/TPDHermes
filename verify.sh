#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
if [[ -f "$ROOT/.venv/bin/activate" ]]; then
  # shellcheck source=/dev/null
  source "$ROOT/.venv/bin/activate"
fi
export PYTHONPATH="$ROOT"
export DATABASE_URL="${DATABASE_URL:-sqlite+aiosqlite:///./tphermes.db}"
echo "[verify] ruff"
ruff check backend main.py
echo "[verify] mypy"
mypy backend main.py
echo "[verify] pytest"
pytest -q
echo "[verify] frontend lint + build"
npm run lint
npm run build
echo "[verify] ok"
