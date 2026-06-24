#!/usr/bin/env bash
# 项目共创（co-create）验收脚本
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

API_BASE="${API_BASE:-http://127.0.0.1:8000/api/v1}"
USER_ID="${VERIFY_USER_ID:-verify_co_create_$(date +%s)}"
HEADERS=(-H "X-User-ID: ${USER_ID}" -H "Content-Type: application/json")

echo "[verify-co-create] API_BASE=${API_BASE}"

# 1. 创建测试项目
PROJECT=$(curl -sf "${HEADERS[@]}" -X POST "${API_BASE}/projects" \
  -d '{"name":"CoCreate Verify","status":"active","background":"验收项目"}')
PROJECT_ID=$(python3 -c "import json,sys; print(json.load(sys.stdin)['id'])" <<<"$PROJECT")
echo "[verify-co-create] project_id=${PROJECT_ID}"

# 2. 统一文件列表
FILES=$(curl -sf "${HEADERS[@]}" "${API_BASE}/projects/${PROJECT_ID}/files")
echo "[verify-co-create] files list ok: $(python3 -c "import json,sys; print(len(json.load(sys.stdin).get('items',[])))" <<<"$FILES") items"

# 3. 会话 co_create 字段 round-trip
SESSION=$(curl -sf "${HEADERS[@]}" -X POST "${API_BASE}/chat/sessions" \
  -d "{\"title\":\"共创验收\",\"sessionKind\":\"project_co_create\",\"selectedProjectId\":\"${PROJECT_ID}\",\"pinnedFileIds\":[],\"roundFileIds\":[]}")
SESSION_ID=$(python3 -c "import json,sys; print(json.load(sys.stdin)['id'])" <<<"$SESSION")
PATCHED=$(curl -sf "${HEADERS[@]}" -X PATCH "${API_BASE}/chat/sessions/${SESSION_ID}" \
  -d '{"roundFileIds":["output:test"],"sessionKind":"project_co_create"}')
echo "[verify-co-create] session patch ok id=${SESSION_ID}"

# 4. file-actions apply (create)
APPLY=$(curl -sf "${HEADERS[@]}" -X POST "${API_BASE}/projects/${PROJECT_ID}/file-actions/apply" \
  -d "{\"proposal_id\":\"p1\",\"action\":{\"type\":\"create\",\"file_name\":\"验收.md\",\"path\":\"/\",\"content\":\"# 验收\\n\"}}")
FILE_ID=$(python3 -c "import json,sys; print(json.load(sys.stdin)['file_id'])" <<<"$APPLY")
echo "[verify-co-create] file apply ok file_id=${FILE_ID}"

# 5. 文件详情
DETAIL=$(curl -sf "${HEADERS[@]}" "${API_BASE}/projects/${PROJECT_ID}/files/${FILE_ID}?kind=output")
echo "[verify-co-create] file detail ok"

# 6. 版本列表
VERSIONS=$(curl -sf "${HEADERS[@]}" "${API_BASE}/projects/${PROJECT_ID}/outputs/${FILE_ID}/versions")
echo "[verify-co-create] versions ok"

echo "[verify-co-create] ALL PASSED"
