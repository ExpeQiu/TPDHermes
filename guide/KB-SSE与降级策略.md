# 知识库 SSE 与降级策略

## 行为说明

- **健康检查**：`GET /api/v1/kb/health` 返回 `external_kb`、`readonly_mode`、`cache_mode` 等。前端 `KBDegradedBanner` 在外部 KB 不可用或只读缓存时提示降级。
- **SSE**：`GET /api/v1/kb/events`（`EventSource`）推送 `sync_complete`、`entry_added` 等事件；知识库页订阅后自动 `reloadKbBrowse()`。事件 JSON 同时包含 **`type` 与 `event_type`**（同值），便于与旧前端字段对齐。
- **浏览数据**：优先 `GET /api/v1/kb/collections` + `GET /api/v1/kb/cache/entries/__all__`；其中 `project_id` 为 `__all__` / `all` / `*` 时表示**不按项目过滤**（跨项目汇总）。无数据时不静默伪造列表。
- **显式 Mock**：设置 `NEXT_PUBLIC_USE_MOCK_KB=true` 时使用内置演示数据，便于无后端环境展示。

## Chroma 配置

- 环境变量 `CHROMA_HOST`（默认 `http://localhost:8001`）由 `kb_proxy` 读取。
