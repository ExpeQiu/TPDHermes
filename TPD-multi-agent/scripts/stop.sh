#!/usr/bin/env bash
set -euo pipefail
LABEL="com.multi-agent.web"
UID_NUM="$(id -u)"
PORT="${MULTI_AGENT_WEB_PORT:-8765}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"

if launchctl print "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1; then
  launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
  echo "unloaded ${LABEL}"
fi
launchctl unload "$PLIST" 2>/dev/null || true

if [[ -f "$ROOT/apps/web/.web.pid" ]]; then
  PID="$(tr -cd '0-9' <"$ROOT/apps/web/.web.pid" || true)"
  if [[ -n "${PID}" ]]; then
    kill "${PID}" 2>/dev/null || true
    kill -9 "${PID}" 2>/dev/null || true
  fi
  rm -f "$ROOT/apps/web/.web.pid"
fi

if lsof -ti ":${PORT}" >/dev/null 2>&1; then
  lsof -ti ":${PORT}" | xargs kill -9 2>/dev/null || true
  echo "cleared port ${PORT}"
fi

echo "Web stopped"
