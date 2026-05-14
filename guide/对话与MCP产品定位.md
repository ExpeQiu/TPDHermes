# 对话、MCP 与飞书 — 产品边界（2.0）

## 对话页（`/chat`）

- **默认链路**：通过 `NEXT_PUBLIC_CHAT_API_URL`（兼容旧名 `NEXT_PUBLIC_HERMES_API_URL`）调用独立聊天补全服务（如本机 `8642`），与 TPDHermes FastAPI **解耦**。
- **可选协同**：若需引用项目 / 知识库 / 工坊结果，应在后续版本定义「上下文注入」契约（本仓库尚未实现统一 BFF）。

## MCP（`backend/mcp_server.py`）

- 定位为 **工具层 / 研发集成**：供 Agent 或外部 IDE 发现技能、触发生成，不作为面向终端用户的产品 HTTP 面。
- 与 FastAPI 主应用分轨部署；若对外暴露需单独鉴权与限流。

## 飞书

- API 位于 `/api/v1/feishu/*`、机器人 `/api/v1/feishu/bot/*`。
- OAuth、租户通知、权限模型见后续「产品化」里程碑；当前以环境变量 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 为可选集成。

## 结果沉淀

- 工坊生成内容持久化、与项目关联、评审闭环：待统一「输出物」数据模型后实现（与 `projects` 扩展或新表相关）。
