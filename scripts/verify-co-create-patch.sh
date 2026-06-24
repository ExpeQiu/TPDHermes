#!/usr/bin/env bash
# 共创改写覆盖保存验收（模拟润色后 full patch overwrite + 版本归档）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

API_BASE="${API_BASE:-http://127.0.0.1:8000/api/v1}"
USER_ID="${VERIFY_USER_ID:-verify_co_create_patch_$(date +%s)}"

echo "[verify-co-create-patch] API_BASE=${API_BASE}"

python3 - <<'PY'
import json
import os
import sys
import urllib.error
import urllib.request

API_BASE = os.environ.get("API_BASE", "http://127.0.0.1:8000/api/v1").rstrip("/")
USER_ID = os.environ["VERIFY_USER_ID"] if "VERIFY_USER_ID" in os.environ else None
if not USER_ID:
    import time
    USER_ID = f"verify_co_create_patch_{int(time.time())}"


def request(method: str, path: str, body: dict | None = None) -> dict:
    url = f"{API_BASE}{path}"
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "X-User-ID": USER_ID,
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        print(f"[verify-co-create-patch] HTTP {exc.code} {method} {path}: {detail}", file=sys.stderr)
        raise


print(f"[verify-co-create-patch] user_id={USER_ID}")

project = request("POST", "/projects/", {"name": "CoCreate Patch Verify", "status": "active"})
project_id = project["id"]
print(f"[verify-co-create-patch] project_id={project_id}")

before = "# 原始稿\n\n" + "段落。\n" * 40
after = before + "\n\n## 润色扩展\n" + "扩展内容。\n" * 120

created = request(
    "POST",
    f"/projects/{project_id}/file-actions/apply",
    {
        "proposal_id": "create-polish",
        "action": {
            "type": "create",
            "file_name": "润色稿.md",
            "path": "/输出",
            "content": before,
        },
    },
)
file_id = created["file_id"]
print(f"[verify-co-create-patch] created file_id={file_id}")

patched = request(
    "POST",
    f"/projects/{project_id}/file-actions/apply",
    {
        "proposal_id": "fallback-patch:simulated",
        "action": {
            "type": "patch",
            "target_file_id": file_id,
            "target_kind": "output",
            "file_name": "润色稿.md",
            "content": after,
            "save_mode": "overwrite",
            "edit_mode": "full",
        },
    },
)
version = str(patched.get("version", ""))
if version != "2":
    raise SystemExit(f"[verify-co-create-patch] FAIL: expected version 2, got {version}")
print(f"[verify-co-create-patch] patch overwrite ok version={version}")

detail = request("GET", f"/projects/{project_id}/files/{file_id}?kind=output")
content = detail.get("content", "")
if len(content) < 800:
    raise SystemExit(f"[verify-co-create-patch] FAIL: content too short ({len(content)})")
print(f"[verify-co-create-patch] detail ok content_len={len(content)}")

versions = request("GET", f"/projects/{project_id}/files/{file_id}/versions?kind=output")
items = versions.get("items", [])
if len(items) < 2:
    raise SystemExit(f"[verify-co-create-patch] FAIL: expected >=2 versions, got {len(items)}")
print(f"[verify-co-create-patch] versions ok count={len(items)}")

print("[verify-co-create-patch] ALL PASSED")
PY
