#!/usr/bin/env bash
# 校验远端生产 compose 文件是否存在且可解析（禁止在本机直接 test -f /opt/...）
# 用法:
#   ./scripts/verify_remote_compose.sh
#   DEPLOY_HOST=root@47.113.225.93 ./scripts/verify_remote_compose.sh
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-root@47.113.225.93}"
DEPLOY_REMOTE_DIR="${DEPLOY_REMOTE_DIR:-/opt/tpdhermes/TPDHermes}"
PROD_FILE="${DEPLOY_REMOTE_DIR}/docker-compose.prod.yml"
SRC_FILE="${DEPLOY_REMOTE_DIR}/docker-compose.src-hermes.yml"

log() { echo "[verify-remote-compose] $(date -Iseconds) $*"; }

if [[ "$(uname -s)" == "Darwin" ]]; then
  local_missing=()
  [[ -f "$PROD_FILE" ]] || local_missing+=("$PROD_FILE")
  [[ -f "$SRC_FILE" ]] || local_missing+=("$SRC_FILE")
  if ((${#local_missing[@]})); then
    log "本机无 /opt 路径（预期）: 勿用本机 test -f /opt/... 判断云上；改走 SSH"
  fi
fi

log "SSH ${DEPLOY_HOST} 检查 compose 文件"
# 用 env 传路径，单引号 heredoc 避免本机误展开 ${#missing[@]}
ssh -o BatchMode=yes -o ConnectTimeout=20 \
  "$DEPLOY_HOST" \
  "PROD=$(printf '%q' "$PROD_FILE") SRC=$(printf '%q' "$SRC_FILE") DIR=$(printf '%q' "$DEPLOY_REMOTE_DIR") /bin/bash -s" <<'REMOTE'
set -euo pipefail
missing=()
for f in "$PROD" "$SRC"; do
  if [[ ! -f "$f" ]]; then
    missing+=("$f")
  fi
done
if ((${#missing[@]})); then
  # 与历史误报同格式；仅远端真缺失时出现
  IFS=,
  echo "[verify-remote-compose] FAIL: [${missing[*]}] 文件不存在" >&2
  unset IFS
  exit 1
fi
echo "[verify-remote-compose] OK: both compose files exist"
ls -la "$PROD" "$SRC"
sha256sum "$PROD" "$SRC"
cd "$DIR"
docker compose -f docker-compose.prod.yml -f docker-compose.src-hermes.yml config --services
REMOTE

log "done"
