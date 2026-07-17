#!/usr/bin/env bash
# start.sh — launchd KeepAlive 托管后端 :8000 + 前端 :3000
# 避免 Cursor Agent 会话回收后台进程导致 ERR_CONNECTION_REFUSED
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
UID_NUM="$(id -u)"
LABEL_BE="com.tphermes.backend"
LABEL_FE="com.tphermes.frontend"
LOCAL_ROOT="${HOME}/Library/Application Support/tphermes"
LOCAL_LOGS="${LOCAL_ROOT}/logs"
LOCAL_RUN_BE="${LOCAL_ROOT}/run-backend.sh"
LOCAL_RUN_FE="${LOCAL_ROOT}/run-frontend.sh"
PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST_BE="${PLIST_DIR}/${LABEL_BE}.plist"
PLIST_FE="${PLIST_DIR}/${LABEL_FE}.plist"
HERMES_ENV_FILE="${HOME}/.hermes/.env"

LOCAL_VENV="${LOCAL_ROOT}/.venv"
LOCAL_DB="${LOCAL_ROOT}/tphermes.db"
mkdir -p "$LOCAL_ROOT" "$LOCAL_LOGS" "$PLIST_DIR" "$ROOT/logs"

# launchd 无法可靠读外置盘 .venv（Operation not permitted）→ 本机 venv + PYTHONPATH 指向源码
export DATABASE_URL="${DATABASE_URL:-sqlite+aiosqlite:///${LOCAL_DB}}"
export PYTHONPATH="$ROOT"

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

# 加载 .env.local 到当前 shell（写入 runner 时再导出）
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

if [[ ! -x "${LOCAL_VENV}/bin/python" ]]; then
  echo "[start] 创建本机 venv: ${LOCAL_VENV}"
  python3 -m venv "$LOCAL_VENV"
fi
echo "[start] sync python deps → 本机 venv"
"${LOCAL_VENV}/bin/pip" install -q -U pip
"${LOCAL_VENV}/bin/pip" install -q -r "$ROOT/requirements.txt"

UVICORN="${LOCAL_VENV}/bin/uvicorn"
if [[ ! -x "$UVICORN" ]]; then
  echo "[start] 缺少 $UVICORN" >&2
  exit 1
fi
if [[ ! -d "$ROOT/node_modules" ]]; then
  echo "[start] npm install"
  (cd "$ROOT" && npm install)
fi

# 若仓库已有 SQLite 且本机库不存在，复制一份避免空库
if [[ ! -f "$LOCAL_DB" && -f "$ROOT/tphermes.db" ]]; then
  echo "[start] 复制数据库 → ${LOCAL_DB}"
  cp "$ROOT/tphermes.db" "$LOCAL_DB"
fi

# 将关键环境写入本机 runner（WorkingDirectory 无空格）
# shellcheck disable=SC2016
cat >"$LOCAL_RUN_BE" <<EOF
#!/bin/bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export DATABASE_URL="${DATABASE_URL}"
export PYTHONPATH="${ROOT}"
export HERMES_CHAT_API_URL="${HERMES_CHAT_API_URL}"
export HERMES_CHAT_API_KEY="${HERMES_CHAT_API_KEY}"
export KB_EMBED_CACHE_DIR="${KB_EMBED_CACHE_DIR}"
export HF_HOME="${HF_HOME}"
export HUGGINGFACE_HUB_CACHE="${HUGGINGFACE_HUB_CACHE}"
export TRANSFORMERS_CACHE="${TRANSFORMERS_CACHE}"
export SENTENCE_TRANSFORMERS_HOME="${SENTENCE_TRANSFORMERS_HOME}"
export MULTI_AGENT_URL="${MULTI_AGENT_URL:-http://127.0.0.1:8766}"
export MULTI_AGENT_ROOT="${MULTI_AGENT_ROOT:-}"
# 工作目录放本机，避免 launchd 对外置盘 cwd 限制；源码经 PYTHONPATH
cd "${LOCAL_ROOT}"
exec "${UVICORN}" main:app --host 127.0.0.1 --port 8000
EOF
chmod +x "$LOCAL_RUN_BE"

NPM_BIN="$(command -v npm || true)"
if [[ -z "$NPM_BIN" ]]; then
  echo "[start] 找不到 npm" >&2
  exit 1
fi
cat >"$LOCAL_RUN_FE" <<EOF
#!/bin/bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:\${PATH:-}"
cd "${ROOT}"
exec "${NPM_BIN}" run dev -- --hostname 127.0.0.1 --port 3000
EOF
chmod +x "$LOCAL_RUN_FE"

bootout_label() {
  local label="$1"
  if launchctl print "gui/${UID_NUM}/${label}" >/dev/null 2>&1; then
    launchctl bootout "gui/${UID_NUM}/${label}" 2>/dev/null || true
    sleep 0.3
  fi
}

bootout_label "$LABEL_BE"
bootout_label "$LABEL_FE"

for port in 8000 3000; do
  if lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[start] 清理端口 :$port"
    lsof -tiTCP:"$port" -sTCP:LISTEN | xargs kill 2>/dev/null || true
    sleep 0.3
  fi
done

write_plist() {
  local label="$1" runner="$2" outlog="$3" errlog="$4" plist="$5"
  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${runner}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${LOCAL_ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>3</integer>
  <key>StandardOutPath</key>
  <string>${outlog}</string>
  <key>StandardErrorPath</key>
  <string>${errlog}</string>
</dict>
</plist>
EOF
}

write_plist "$LABEL_BE" "$LOCAL_RUN_BE" \
  "${LOCAL_LOGS}/backend.out.log" "${LOCAL_LOGS}/backend.err.log" "$PLIST_BE"
write_plist "$LABEL_FE" "$LOCAL_RUN_FE" \
  "${LOCAL_LOGS}/frontend.out.log" "${LOCAL_LOGS}/frontend.err.log" "$PLIST_FE"

launchctl bootstrap "gui/${UID_NUM}" "$PLIST_BE"
launchctl bootstrap "gui/${UID_NUM}" "$PLIST_FE"
launchctl kickstart -k "gui/${UID_NUM}/${LABEL_BE}" 2>/dev/null || true
launchctl kickstart -k "gui/${UID_NUM}/${LABEL_FE}" 2>/dev/null || true

ln -sfn "${LOCAL_LOGS}/backend.out.log" "$ROOT/logs/backend.launchd.out.log"
ln -sfn "${LOCAL_LOGS}/backend.err.log" "$ROOT/logs/backend.launchd.err.log"
ln -sfn "${LOCAL_LOGS}/frontend.out.log" "$ROOT/logs/frontend.launchd.out.log"
ln -sfn "${LOCAL_LOGS}/frontend.err.log" "$ROOT/logs/frontend.launchd.err.log"

wait_http() {
  local url="$1" name="$2" tries="${3:-80}" timeout="${4:-5}"
  local i
  for i in $(seq 1 "$tries"); do
    if curl -sf --max-time "$timeout" "$url" >/dev/null 2>&1; then
      echo "[start] ${name} OK  ${url}"
      return 0
    fi
    sleep 0.25
  done
  echo "[start] ${name} 启动失败: ${url}" >&2
  return 1
}

be_ok=0
fe_ok=0
# /health 含飞书探测，单次可能 >1s
if wait_http "http://127.0.0.1:8000/health" "backend" 60 10; then be_ok=1; fi
# Next 首编可能较慢
if wait_http "http://127.0.0.1:3000/" "frontend" 120 5; then fe_ok=1; fi

BPID="$(lsof -tiTCP:8000 -sTCP:LISTEN 2>/dev/null | head -1 || true)"
FPID="$(lsof -tiTCP:3000 -sTCP:LISTEN 2>/dev/null | head -1 || true)"
[[ -n "${BPID}" ]] && echo "${BPID}" >"$ROOT/.backend.pid"
[[ -n "${FPID}" ]] && echo "${FPID}" >"$ROOT/.frontend.pid"

if [[ "$be_ok" -ne 1 || "$fe_ok" -ne 1 ]]; then
  echo "[start] 查看日志:" >&2
  echo "  ${LOCAL_LOGS}/backend.err.log" >&2
  echo "  ${LOCAL_LOGS}/frontend.err.log" >&2
  tail -n 40 "${LOCAL_LOGS}/backend.err.log" 2>/dev/null || true
  tail -n 40 "${LOCAL_LOGS}/frontend.err.log" 2>/dev/null || true
  exit 1
fi

echo "[start] 托管: launchd ${LABEL_BE} + ${LABEL_FE} (KeepAlive)"
echo "[start] 前端 http://127.0.0.1:3000/"
echo "[start] 后端 http://127.0.0.1:8000/health"
echo "[start] 停止: ./stop.sh"
