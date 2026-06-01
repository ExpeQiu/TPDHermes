#!/usr/bin/env bash
set -euo pipefail

# 批量回填 skills.config
# 用法：
#   ./scripts/batch_patch_skill_config.sh \
#     --base-url "http://tphermes-backend:8000/api/v1" \
#     --manifest "./scripts/skill_config_manifest.example.json" \
#     --token "$TPD_TOKEN"

BASE_URL=""
MANIFEST=""
TOKEN="${TPD_TOKEN:-}"
DRY_RUN="false"
LOG_DIR="./logs"
TIME_TAG="$(date +"%Y%m%d_%H%M%S")"
LOG_FILE=""

usage() {
  cat <<'EOF'
Usage:
  batch_patch_skill_config.sh --base-url <url> --manifest <json-file> [--token <token>] [--dry-run]

Arguments:
  --base-url   API 基地址（示例: http://tphermes-backend:8000/api/v1）
  --manifest   清单文件，格式见 scripts/skill_config_manifest.example.json
  --token      可选，若接口需要鉴权则传 Bearer token；也可通过环境变量 TPD_TOKEN 提供
  --dry-run    仅打印将要执行的 PATCH，不真正调用接口

Manifest JSON 格式:
[
  {
    "name": "your_skill_name",
    "description": "可选，日志用途",
    "config_file": "./tmp/skills/your_skill_name/config.json"
  }
]

其中 config_file 指向的内容必须是合法 JSON 对象（如 {"prompt":"...","version":"1.0.0"}）。
EOF
}

log() {
  local level="$1"
  shift
  local msg="$*"
  printf '%s [%s] %s\n' "$(date +"%F %T")" "$level" "$msg" | tee -a "$LOG_FILE"
}

fail() {
  log "ERROR" "$*"
  exit 1
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --base-url)
        BASE_URL="${2:-}"
        shift 2
        ;;
      --manifest)
        MANIFEST="${2:-}"
        shift 2
        ;;
      --token)
        TOKEN="${2:-}"
        shift 2
        ;;
      --dry-run)
        DRY_RUN="true"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        echo "Unknown arg: $1"
        usage
        exit 1
        ;;
    esac
  done
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "缺少命令: $1"
}

validate_manifest() {
  [[ -f "$MANIFEST" ]] || fail "manifest 不存在: $MANIFEST"
  jq -e 'type == "array"' "$MANIFEST" >/dev/null || fail "manifest 顶层必须是 JSON 数组"
  jq -e 'all(.[]; has("name") and has("config_file"))' "$MANIFEST" >/dev/null || fail "manifest 每项必须包含 name 与 config_file"
}

main() {
  parse_args "$@"
  [[ -n "$BASE_URL" ]] || fail "--base-url 必填"
  [[ -n "$MANIFEST" ]] || fail "--manifest 必填"

  mkdir -p "$LOG_DIR"
  LOG_FILE="${LOG_DIR}/skill_config_backfill_${TIME_TAG}.log"

  require_cmd jq
  require_cmd curl
  validate_manifest

  local total success failed skipped
  total="$(jq 'length' "$MANIFEST")"
  success=0
  failed=0
  skipped=0

  log "INFO" "开始执行批量回填 total=${total} dry_run=${DRY_RUN} base_url=${BASE_URL}"

  for i in $(seq 0 $((total - 1))); do
    local name desc cfg_file cfg_json payload url code body tmp_file
    name="$(jq -r ".[$i].name" "$MANIFEST")"
    desc="$(jq -r ".[$i].description // \"\"" "$MANIFEST")"
    cfg_file="$(jq -r ".[$i].config_file" "$MANIFEST")"

    if [[ ! -f "$cfg_file" ]]; then
      log "WARN" "跳过 name=${name} 原因=config_file不存在 file=${cfg_file}"
      skipped=$((skipped + 1))
      continue
    fi

    if ! jq -e 'type == "object"' "$cfg_file" >/dev/null 2>&1; then
      log "WARN" "跳过 name=${name} 原因=config_file不是JSON对象 file=${cfg_file}"
      skipped=$((skipped + 1))
      continue
    fi

    cfg_json="$(jq -c '.' "$cfg_file")"
    payload="$(jq -cn --argjson cfg "$cfg_json" '{config:$cfg}')"
    url="${BASE_URL%/}/skills/${name}/config"

    if [[ "$DRY_RUN" == "true" ]]; then
      log "INFO" "DRY-RUN name=${name} desc=${desc} url=${url} payload_bytes=$(printf '%s' "$payload" | wc -c | tr -d ' ')"
      success=$((success + 1))
      continue
    fi

    tmp_file="$(mktemp)"
    if [[ -n "$TOKEN" ]]; then
      code="$(
        curl -sS -o "$tmp_file" -w '%{http_code}' \
          -X PATCH "$url" \
          -H "Content-Type: application/json" \
          -H "Authorization: Bearer $TOKEN" \
          -d "$payload" || true
      )"
    else
      code="$(
        curl -sS -o "$tmp_file" -w '%{http_code}' \
          -X PATCH "$url" \
          -H "Content-Type: application/json" \
          -d "$payload" || true
      )"
    fi
    body="$(cat "$tmp_file")"
    rm -f "$tmp_file"

    if [[ "$code" =~ ^2[0-9][0-9]$ ]]; then
      log "INFO" "成功 name=${name} code=${code} resp=$(printf '%s' "$body" | jq -c '{name, source, enabled, updated_at}' 2>/dev/null || printf '%s' "$body")"
      success=$((success + 1))
    else
      log "ERROR" "失败 name=${name} code=${code} resp=${body}"
      failed=$((failed + 1))
    fi
  done

  log "INFO" "执行完成 total=${total} success=${success} failed=${failed} skipped=${skipped} log_file=${LOG_FILE}"

  if [[ "$failed" -gt 0 ]]; then
    exit 2
  fi
}

main "$@"
