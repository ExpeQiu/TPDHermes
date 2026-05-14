"""pytest 入口：保证仓库根在 sys.path，CI 不依赖隐式工作目录。"""
import os
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

os.environ.setdefault(
    "DATABASE_URL",
    "sqlite+aiosqlite:////tmp/tphermes_pytest.db",
)
