#!/usr/bin/env bash
# start.sh — 将 Web 运行时镜像到本机目录，用 launchd KeepAlive 托管
# 避免：① Cursor Agent 会话回收后台进程 ② /Volumes/Lexar 空格路径导致 launchd EX_CONFIG
set -euo pipefail

SRC_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.multi-agent.web"
UID_NUM="$(id -u)"
PORT="${MULTI_AGENT_WEB_PORT:-8765}"
HOST="${MULTI_AGENT_WEB_HOST:-127.0.0.1}"

LOCAL_ROOT="${HOME}/Library/Application Support/multi-agent"
LOCAL_WEB="${LOCAL_ROOT}/web"
LOCAL_LOGS="${LOCAL_ROOT}/logs"
LOCAL_RUNS="${LOCAL_ROOT}/runs"
LOCAL_RUNNER="${LOCAL_ROOT}/run.sh"
PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST="${PLIST_DIR}/${LABEL}.plist"

mkdir -p "$LOCAL_WEB/static" "$LOCAL_LOGS" "$LOCAL_RUNS" "$PLIST_DIR" "$SRC_ROOT/logs"

# 同步前端与服务器代码到本机（无空格路径）
cp "$SRC_ROOT/apps/web/app.py" "$LOCAL_WEB/app.py"
rm -rf "$LOCAL_WEB/static"
cp -R "$SRC_ROOT/apps/web/static" "$LOCAL_WEB/static"

# 确保源仓 venv
PY="${SRC_ROOT}/.venv/bin/python"
if [[ ! -x "$PY" ]]; then
  python3 -m venv "${SRC_ROOT}/.venv"
  "$PY" -m pip install -q -e "$SRC_ROOT"
fi
# package 可导入
"$PY" -c "import multi_agent" >/dev/null

# 本机 runner：PYTHONPATH 指向源仓，代码在本机执行
cat >"$LOCAL_RUNNER" <<EOF
#!/bin/bash
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export MULTI_AGENT_RUNS_DIR="${LOCAL_RUNS}"
export MULTI_AGENT_WEB_PORT="${PORT}"
export MULTI_AGENT_WEB_HOST="${HOST}"
export PYTHONPATH="${SRC_ROOT}\${PYTHONPATH:+:\$PYTHONPATH}"
cd "${LOCAL_WEB}"
exec "${PY}" "${LOCAL_WEB}/app.py"
EOF
chmod +x "$LOCAL_RUNNER"

# 停旧服务
if launchctl print "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1; then
  launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
  sleep 0.4
fi
launchctl unload "$PLIST" 2>/dev/null || true
if lsof -ti ":${PORT}" >/dev/null 2>&1; then
  lsof -ti ":${PORT}" | xargs kill -9 2>/dev/null || true
  sleep 0.2
fi

cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${LOCAL_RUNNER}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${LOCAL_WEB}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>3</integer>
  <key>StandardOutPath</key>
  <string>${LOCAL_LOGS}/web.out.log</string>
  <key>StandardErrorPath</key>
  <string>${LOCAL_LOGS}/web.err.log</string>
</dict>
</plist>
EOF

launchctl bootstrap "gui/${UID_NUM}" "$PLIST"
launchctl kickstart -k "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true

URL="http://127.0.0.1:${PORT}"
ok=0
for _ in $(seq 1 80); do
  # 必须校验 service 字段：避免同端口其它服务（如 screen-watch）的 /api/health 误判成功
  body="$(curl -sf --max-time 1 "${URL}/api/health" 2>/dev/null || true)"
  if [[ "$body" == *"multi-agent-web"* ]]; then
    ok=1
    break
  fi
  # 若 launchd 已在跑但尚未就绪，继续等（勿过早失败）
  sleep 0.25
done

if [[ "$ok" -ne 1 ]]; then
  echo "启动失败。查看:" >&2
  echo "  ${LOCAL_LOGS}/web.err.log" >&2
  echo "  ${LOCAL_LOGS}/web.out.log" >&2
  tail -n 60 "${LOCAL_LOGS}/web.err.log" 2>/dev/null || true
  tail -n 60 "${LOCAL_LOGS}/web.out.log" 2>/dev/null || true
  launchctl print "gui/${UID_NUM}/${LABEL}" 2>&1 | head -60 >&2 || true
  exit 1
fi

LPID="$(lsof -tiTCP:${PORT} -sTCP:LISTEN 2>/dev/null | head -1 || true)"
mkdir -p "$SRC_ROOT/apps/web"
[[ -n "${LPID}" ]] && echo "${LPID}" >"$SRC_ROOT/apps/web/.web.pid"

# 方便本仓 logs 联调
ln -sfn "${LOCAL_LOGS}/web.out.log" "$SRC_ROOT/logs/web.launchd.out.log"
ln -sfn "${LOCAL_LOGS}/web.err.log" "$SRC_ROOT/logs/web.launchd.err.log"

echo "Web OK  ${URL}/"
echo "托管: launchd ${LABEL} (KeepAlive)"
echo "本机目录: ${LOCAL_ROOT}"
echo "停止: ./scripts/stop.sh"
echo ""
echo "Cursor 注意: Agent 里 nohup 的进程会被会话结束杀掉；"
echo "请用 ./scripts/start.sh（launchd），再用 Simple Browser 打开 ${URL}/"
