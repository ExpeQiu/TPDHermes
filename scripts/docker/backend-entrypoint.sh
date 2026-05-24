#!/usr/bin/env sh
set -eu

log() {
  echo "[backend-entrypoint] $*"
}

KB_EMBED_BOOT_PRELOAD="${KB_EMBED_BOOT_PRELOAD:-1}"
KB_EMBED_BOOT_PRELOAD_TIMEOUT_SEC="${KB_EMBED_BOOT_PRELOAD_TIMEOUT_SEC:-240}"
KB_EMBED_BOOT_PRELOAD_STRICT="${KB_EMBED_BOOT_PRELOAD_STRICT:-0}"

CACHE_ROOT="${KB_EMBED_CACHE_DIR:-${HF_HOME:-/app/.cache/huggingface}}"
export KB_EMBED_CACHE_DIR="$CACHE_ROOT"
export HF_HOME="${HF_HOME:-$CACHE_ROOT}"
export HUGGINGFACE_HUB_CACHE="${HUGGINGFACE_HUB_CACHE:-$CACHE_ROOT/hub}"
export TRANSFORMERS_CACHE="${TRANSFORMERS_CACHE:-$CACHE_ROOT/transformers}"
export SENTENCE_TRANSFORMERS_HOME="${SENTENCE_TRANSFORMERS_HOME:-$CACHE_ROOT/sentence_transformers}"

mkdir -p "$CACHE_ROOT" "$HUGGINGFACE_HUB_CACHE" "$TRANSFORMERS_CACHE" "$SENTENCE_TRANSFORMERS_HOME"
log "embed cache dir=$CACHE_ROOT"

case "$(echo "$KB_EMBED_BOOT_PRELOAD" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on)
    log "preload model=${KB_EMBED_MODEL:-BAAI/bge-small-zh-v1.5} timeout=${KB_EMBED_BOOT_PRELOAD_TIMEOUT_SEC}s"
    PRELOAD_PY_FILE="$(mktemp)"
    cat > "$PRELOAD_PY_FILE" <<'PY'
import os
import time
from sentence_transformers import SentenceTransformer

model = os.getenv("KB_EMBED_MODEL", "BAAI/bge-small-zh-v1.5").strip()
t0 = time.time()
SentenceTransformer(model)
dt = time.time() - t0
print(f"[backend-entrypoint] preload done model={model} elapsed={dt:.2f}s")
PY
    if timeout "${KB_EMBED_BOOT_PRELOAD_TIMEOUT_SEC}" python "$PRELOAD_PY_FILE"; then
      :
    else
      log "preload failed or timed out"
      case "$(echo "$KB_EMBED_BOOT_PRELOAD_STRICT" | tr '[:upper:]' '[:lower:]')" in
        1|true|yes|on)
          log "strict mode on, exiting"
          exit 1
          ;;
        *)
          log "strict mode off, continue startup"
          ;;
      esac
    fi
    rm -f "$PRELOAD_PY_FILE"
    ;;
  *)
    log "preload disabled"
    ;;
esac

exec "$@"
