#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

VENV="$ROOT/.venv"
if [[ ! -d "$VENV" ]]; then
  echo "==> 创建 venv"
  python3 -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"

echo "==> 安装"
python -m pip install -q -U pip
python -m pip install -q -e ".[dev]"

echo "==> CLI 基础"
multi-agent --version
multi-agent --help >/dev/null

echo "==> 离线 smoke：三模式 --demo"
multi-agent mode roundtable --topic "verify-圆桌" --pack nev-tech --rounds 1 --format json --demo >/tmp/ma-rt.json
multi-agent mode consult --goal "verify-包装脚本" --pack nev-tech --format json --demo >/tmp/ma-cs.json
multi-agent mode swarm --goal "verify-对比供应链" --max-parallel 3 --format json --demo >/tmp/ma-sw.json
multi-agent run start --goal "verify-怎么推技术信仰" --mode auto --format json --demo >/tmp/ma-auto.json

echo "==> JSON 契约断言"
python - <<'PY'
import json
required = ["module", "data_source", "run_id", "mode", "coordinator", "delivery"]
for path in ["/tmp/ma-rt.json", "/tmp/ma-cs.json", "/tmp/ma-sw.json", "/tmp/ma-auto.json"]:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    for k in required:
        assert k in data, f"{path} missing {k}"
    assert isinstance(data["data_source"], str) and data["data_source"], path
    assert data["delivery"].get("body_markdown"), path
    print("OK", path, data["mode"], data["run_id"])
PY

echo "==> status / trajectory / export / list"
RUN_ID=$(python -c "import json;print(json.load(open('/tmp/ma-sw.json'))['run_id'])")
multi-agent run status "$RUN_ID" --format json >/tmp/ma-st.json
multi-agent run trajectory "$RUN_ID" --format markdown >/tmp/ma-tr.md
test -s /tmp/ma-tr.md
multi-agent run export "$RUN_ID" --what delivery --format markdown >/tmp/ma-ex.md
test -s /tmp/ma-ex.md
multi-agent run list --format json >/tmp/ma-runlist.json

echo "==> 资源面 / doctor"
multi-agent pack list --format json >/tmp/ma-packs.json
multi-agent role list --format json >/tmp/ma-roles.json
multi-agent skill list --format json >/tmp/ma-skills.json
multi-agent knowledge list --format json >/tmp/ma-kb.json
multi-agent doctor --format json >/tmp/ma-doctor.json
python - <<'PY'
import json
for path, module in [
    ("/tmp/ma-packs.json", "pack-list"),
    ("/tmp/ma-roles.json", "role-list"),
    ("/tmp/ma-skills.json", "skill-list"),
    ("/tmp/ma-kb.json", "knowledge-list"),
    ("/tmp/ma-runlist.json", "run-list"),
]:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    assert data["module"] == module, (path, data.get("module"))
    assert "items" in data, path
    assert isinstance(data["items"], list), path
    print("OK", path, data["module"], "count=", data.get("count"))
with open("/tmp/ma-doctor.json", encoding="utf-8") as f:
    doc = json.load(f)
assert doc["module"] == "doctor"
assert doc.get("ok") is True
assert "packs" in doc and "runs_count" in doc
print("OK doctor packs=", doc["packs"], "runs=", doc["runs_count"])
PY

echo "==> pytest"
python -m pytest -q tests/

echo "==> verify 通过"
