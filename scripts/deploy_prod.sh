#!/usr/bin/env bash
# TPDHermes 生产增量部署（本地 rsync + 远程构建，或服务器上直接执行）
# 参考 EPLOY.md：按变更范围构建，避免无谓重建 hermes-agent 镜像。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DEPLOY_HOST="${DEPLOY_HOST:-root@47.113.225.93}"
DEPLOY_REMOTE_DIR="${DEPLOY_REMOTE_DIR:-/opt/tpdhermes/TPDHermes}"
DEPLOY_SSH_PASS="${DEPLOY_SSH_PASS:-}"
DEPLOY_SINCE="${DEPLOY_SINCE:-HEAD~1}"
DEPLOY_CHANGED_FILES="${DEPLOY_CHANGED_FILES:-}"

MODE="local"
FORCE_ALL=0
DRY_RUN=0
RESTART_AGENT=0
BUILD_SERVICES=()
UP_SERVICES=()
RESTART_AGENT_EXPLICIT=0
MANUAL_SERVICES=0

log() { echo "[deploy] $(date -Iseconds) $*"; }

usage() {
  cat <<'EOF'
用法:
  ./scripts/deploy_prod.sh [选项]              # 在服务器项目目录执行
  ./scripts/deploy_prod.sh --remote [选项]     # 本机 rsync 后 SSH 远程执行

选项:
  --all              构建 frontend + backend + tphermes-mcp（不构建 hermes-agent 镜像）
  --since REF        用 git diff REF..HEAD 判断变更（默认 HEAD~1）
  --services S       手动指定构建服务，逗号分隔，如 backend,frontend
  --restart-agent    强制 restart hermes-agent（配置未改也会重启）
  --dry-run          只打印将执行的操作
  -h, --help

环境变量:
  DEPLOY_HOST        SSH 目标，默认 root@47.113.225.93
  DEPLOY_REMOTE_DIR  远程目录，默认 /opt/tpdhermes/TPDHermes
  DEPLOY_SSH_PASS    若设置则用 sshpass（勿写入仓库）
  DEPLOY_CHANGED_FILES  逗号或换行分隔的变更路径（远程模式由本机 git 传入）
  DEPLOY_SINCE       git 对比基准，默认 HEAD~1

示例:
  DEPLOY_SSH_PASS='***' ./scripts/deploy_prod.sh --remote
  ./scripts/deploy_prod.sh --all
  ./scripts/deploy_prod.sh --services backend,tphermes-mcp
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote) MODE="remote"; shift ;;
    --local) MODE="local"; shift ;;
    --all) FORCE_ALL=1; shift ;;
    --since) DEPLOY_SINCE="${2:?}"; shift 2 ;;
    --services)
      IFS=',' read -r -a BUILD_SERVICES <<<"${2:?}"
      MANUAL_SERVICES=1
      shift 2
      ;;
    --restart-agent) RESTART_AGENT_EXPLICIT=1; RESTART_AGENT=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage; exit 1 ;;
  esac
done

COMPOSE_FILES=(-f docker-compose.prod.yml)
if [[ -f docker-compose.src-hermes.yml ]]; then
  COMPOSE_FILES+=(-f docker-compose.src-hermes.yml)
fi

dc() { docker compose "${COMPOSE_FILES[@]}" "$@"; }

ensure_hermes_output_dirs() {
  if ! dc ps --status running --services 2>/dev/null | grep -qx hermes-agent; then
    log "skip ensure hermes output dirs (hermes-agent not running)"
    return 0
  fi
  log "ensure hermes-agent output dirs (/opt/data/输出)"
  dc exec -T hermes-agent sh -lc '
    mkdir -p /opt/data/输出 /opt/data/output /opt/data/workspace
    ln -sfn /opt/data/输出 /opt/data/workspace/输出
  ' || log "WARN: ensure hermes output dirs failed"
}

ssh_cmd() {
  if [[ -n "$DEPLOY_SSH_PASS" ]]; then
    sshpass -p "$DEPLOY_SSH_PASS" ssh -o StrictHostKeyChecking=no "$@"
  else
    ssh -o StrictHostKeyChecking=no "$@"
  fi
}

rsync_to_remote() {
  log "rsync -> ${DEPLOY_HOST}:${DEPLOY_REMOTE_DIR}"
  local -a rsync_ssh=(-o StrictHostKeyChecking=no)
  if [[ -n "$DEPLOY_SSH_PASS" ]]; then
    rsync -avz --delete \
      --exclude='.git' \
      --exclude='hermes-agent/' \
      --exclude='node_modules/' \
      --exclude='.venv/' \
      --exclude='.env.local' \
      --exclude='.env' \
      --exclude='tphermes.db' \
      --exclude='logs/' \
      --exclude='__pycache__/' \
      --exclude='.next/' \
      --exclude='*.pid' \
      --exclude='tsconfig.tsbuildinfo' \
      --exclude='.mypy_cache/' \
      --exclude='.pytest_cache/' \
      --exclude='.cursor/' \
      -e "sshpass -p ${DEPLOY_SSH_PASS} ssh -o StrictHostKeyChecking=no" \
      ./ "${DEPLOY_HOST}:${DEPLOY_REMOTE_DIR}/"
  else
    rsync -avz --delete \
      --exclude='.git' \
      --exclude='hermes-agent/' \
      --exclude='node_modules/' \
      --exclude='.venv/' \
      --exclude='.env.local' \
      --exclude='.env' \
      --exclude='tphermes.db' \
      --exclude='logs/' \
      --exclude='__pycache__/' \
      --exclude='.next/' \
      --exclude='*.pid' \
      --exclude='tsconfig.tsbuildinfo' \
      --exclude='.mypy_cache/' \
      --exclude='.pytest_cache/' \
      --exclude='.cursor/' \
      -e "ssh ${rsync_ssh[*]}" \
      ./ "${DEPLOY_HOST}:${DEPLOY_REMOTE_DIR}/"
  fi
}

collect_changed_files() {
  if [[ -n "$DEPLOY_CHANGED_FILES" ]]; then
    echo "$DEPLOY_CHANGED_FILES" | tr ',' '\n' | awk 'NF'
    return
  fi
  if git rev-parse --is-inside-work-tree &>/dev/null; then
    {
      git diff --name-only "$DEPLOY_SINCE" HEAD 2>/dev/null || true
      git diff --name-only --cached 2>/dev/null || true
      git diff --name-only 2>/dev/null || true
    } | awk 'NF && !seen[$0]++'
  fi
}

classify_changes() {
  local files="$1"
  local need_frontend=0 need_backend=0 need_nginx=0 need_agent=0
  local line

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    case "$line" in
      src/*|public/*|package.json|package-lock.json|Dockerfile|next.config.*|tsconfig.json)
        need_frontend=1 ;;
      backend/*|main.py|requirements.txt|backend.Dockerfile|schema.sql)
        need_backend=1 ;;
      skills/*)
        need_backend=1 ;;
      nginx/*)
        need_nginx=1 ;;
      deploy/hermes-agent/*)
        need_agent=1 ;;
    esac
  done <<<"$files"

  if [[ "$FORCE_ALL" -eq 1 ]]; then
    need_frontend=1
    need_backend=1
  fi

  if [[ "$MANUAL_SERVICES" -eq 0 ]]; then
    BUILD_SERVICES=()
    [[ "$need_frontend" -eq 1 ]] && BUILD_SERVICES+=(frontend)
    if [[ "$need_backend" -eq 1 ]]; then
      BUILD_SERVICES+=(backend tphermes-mcp)
    fi
  fi

  UP_SERVICES=()
  if [[ "$MANUAL_SERVICES" -eq 1 ]]; then
    local s
    for s in "${BUILD_SERVICES[@]}"; do
      case "$s" in
        frontend) UP_SERVICES+=(frontend) ;;
        backend) UP_SERVICES+=(backend) ;;
        tphermes-mcp) UP_SERVICES+=(tphermes-mcp) ;;
        nginx) UP_SERVICES+=(nginx) ;;
      esac
    done
    if [[ " ${UP_SERVICES[*]} " == *" frontend "* ]] || [[ " ${UP_SERVICES[*]} " == *" backend "* ]]; then
      UP_SERVICES+=(nginx)
    fi
  else
    [[ "$need_frontend" -eq 1 ]] && UP_SERVICES+=(frontend)
    [[ "$need_backend" -eq 1 ]] && UP_SERVICES+=(backend tphermes-mcp)
    [[ "$need_nginx" -eq 1 || ${#UP_SERVICES[@]} -gt 0 ]] && UP_SERVICES+=(nginx)
  fi

  if [[ "$need_agent" -eq 1 || "$RESTART_AGENT_EXPLICIT" -eq 1 ]]; then
    RESTART_AGENT=1
  fi

  # 去重
  if [[ ${#UP_SERVICES[@]} -gt 0 ]]; then
    local -a uniq=()
    local s u found
    for s in "${UP_SERVICES[@]}"; do
      found=0
      for u in "${uniq[@]:-}"; do
        [[ "$u" == "$s" ]] && found=1 && break
      done
      [[ "$found" -eq 0 ]] && uniq+=("$s")
    done
    UP_SERVICES=("${uniq[@]}")
  fi

  if [[ ${#BUILD_SERVICES[@]} -eq 0 && "$FORCE_ALL" -eq 0 && "$MANUAL_SERVICES" -eq 0 ]]; then
    log "未检测到需构建的变更（可用 --all 或 --services）"
  else
    log "计划构建: ${BUILD_SERVICES[*]:-(无)}"
    log "计划拉起: ${UP_SERVICES[*]:-(无)}"
  fi
}

run_deploy_on_server() {
  local files
  files="$(collect_changed_files)"
  classify_changes "$files"

  if [[ ${#BUILD_SERVICES[@]} -gt 0 ]]; then
    log "build: ${BUILD_SERVICES[*]}"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      echo "  DOCKER_BUILDKIT=1 docker compose ... build ${BUILD_SERVICES[*]}"
    else
      DOCKER_BUILDKIT=1 dc build "${BUILD_SERVICES[@]}"
    fi
  fi

  if [[ ${#UP_SERVICES[@]} -gt 0 ]]; then
    log "up --no-build: ${UP_SERVICES[*]}"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      echo "  docker compose ... up -d --no-build ${UP_SERVICES[*]}"
    else
      dc up -d --no-build "${UP_SERVICES[@]}"
      if [[ " ${UP_SERVICES[*]} " == *" nginx "* ]] || [[ " ${UP_SERVICES[*]} " == *" backend "* ]] || [[ " ${UP_SERVICES[*]} " == *" frontend "* ]]; then
        log "force-recreate nginx（避免 backend IP 变更 502）"
        dc up -d --force-recreate nginx
      fi
    fi
  fi

  if [[ "$RESTART_AGENT" -eq 1 ]]; then
    log "restart hermes-agent（配置或显式要求）"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      echo "  docker compose ... restart hermes-agent"
    else
      dc restart hermes-agent
      sleep 2
      ensure_hermes_output_dirs
    fi
  else
    log "跳过 hermes-agent restart（配置未变更）"
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    return 0
  fi

  if [[ ${#UP_SERVICES[@]} -eq 0 && "$RESTART_AGENT" -eq 0 ]]; then
    log "无服务重启，跳过 health check"
    return 0
  fi

  sleep 2
  log "health check"
  if curl -sf http://127.0.0.1:8033/health >/dev/null; then
    curl -sS http://127.0.0.1:8033/health | head -c 200
    echo
  else
    log "WARN: /health 未返回 200，请检查 docker compose ps / logs"
    dc ps || true
    exit 1
  fi
  dc ps
}

if [[ "$MODE" == "remote" ]]; then
  files="$(collect_changed_files)"
  if [[ -n "$files" ]]; then
    count="$(echo "$files" | wc -l | tr -d ' ')"
    log "检测到 ${count} 个变更文件"
    DEPLOY_CHANGED_FILES="$(echo "$files" | paste -sd, -)"
  fi
  if [[ "$DRY_RUN" -eq 0 ]]; then
    rsync_to_remote
  else
    log "dry-run: 跳过 rsync"
  fi
  remote_cmd="cd ${DEPLOY_REMOTE_DIR} && chmod +x scripts/deploy_prod.sh"
  remote_cmd+=" && DEPLOY_CHANGED_FILES='${DEPLOY_CHANGED_FILES}' DEPLOY_SSH_PASS= ./scripts/deploy_prod.sh --local"
  [[ "$FORCE_ALL" -eq 1 ]] && remote_cmd+=" --all"
  if [[ "$MANUAL_SERVICES" -eq 1 ]]; then
    remote_cmd+=" --services $(IFS=,; echo "${BUILD_SERVICES[*]}")"
  fi
  [[ "$RESTART_AGENT_EXPLICIT" -eq 1 ]] && remote_cmd+=" --restart-agent"
  [[ "$DRY_RUN" -eq 1 ]] && remote_cmd+=" --dry-run"
  log "ssh 执行远程部署"
  if [[ "$DRY_RUN" -eq 0 ]]; then
    ssh_cmd "$DEPLOY_HOST" "$remote_cmd"
  else
    echo "  $remote_cmd"
  fi
else
  run_deploy_on_server
fi

log "完成"
