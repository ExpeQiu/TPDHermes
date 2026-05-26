"""测试默认环境：避免未设置 HERMES_CHAT_API_URL 时 lifespan 拒绝启动。"""

import os

os.environ.setdefault(
    "HERMES_CHAT_API_URL",
    "http://127.0.0.1:65535/v1/chat/completions",
)
os.environ.setdefault("WORKSHOP_EXECUTION_MODE", "direct")
os.environ.setdefault("GROWTH_SCHEDULER_ENABLED", "false")
