# TPDHermes Quickstart

## 一句话描述

主控 Agent：统一管理多模型路由、MCP 工具调用、知识库检索的 AI 助手后端，提供 Web UI 和 API。

## 快速启动（3 步跑通）

```bash
# 1. 安装依赖
pip install -r requirements.txt

# 2. 启动服务（自动启动后端 :8000 + 前端 :3000）
./start.sh

# 3. 打开浏览器
open http://127.0.0.1:3000
```

> 首次启动需配置 `HERMES_CHAT_API_KEY`（写入 `~/.hermes/.env` 或当前 shell），否则 `/chat` 调用 Hermes-agent 会鉴权失败。

## 主要功能

| 功能 | 说明 |
|------|------|
| 多模型路由 | 统一调度 OpenAI / Claude / DeepSeek 等模型 |
| MCP 工具 | 支持 FastMCP 协议扩展工具调用 |
| 知识库检索 | Chroma 向量库 + Sentence-Transformers 语义检索；与 myKW 手动双向同步见 `guide/myKW双向同步.md` |
| Web UI | Next.js 前端，支持对话、工具调用可视化 |
| API 接口 | FastAPI 后端，前缀 `/api/v1`，文档在 `/docs` |

## 架构模板

```
[Browser] → Next.js (:3000) → FastAPI (:8000)
                                      ↓
                               SQLite DB (aiosqlite)
                                      ↓
                          [Hermes-agent] ← HERMES_CHAT_API_KEY
                                      ↓
                          [MCP Tools] / [Knowledge Base]
```

- **后端**：FastAPI + SQLite (aiosqlite)
- **前端**：Next.js + Tailwind CSS
- **知识库**：Chroma + Sentence-Transformers
- **Agent**：Hermes-agent (独立服务)
- **部署**：Docker Compose (`docker compose up --build`)

## 依赖环境

| 依赖 | 版本 |
|------|------|
| Python | ≥ 3.11 |
| Node.js | ≥ 18 |
| pip | 最新 |
| Docker | 24+ (可选) |
| SQLite | 内置 |

## 常见问题

**Q: 启动报 `ERR_CONNECTION_REFUSED`**
A: 可能是 launchd 杀掉后台进程导致端口未监听。执行 `./start.sh` 重新拉起。

**Q: `/chat` 鉴权失败**
A: 检查 `HERMES_CHAT_API_KEY` 是否已配置，写入 `~/.hermes/.env` 或当前 shell 环境变量。

**Q: FastMCP 兼容性**
A: 建议锁定 `fastmcp>=0.9.0,<1.0.0`，避免与主依赖链冲突；使用虚拟环境隔离。

**Q: 外置盘启动失败**
A: macOS launchd 无法可靠访问外置盘，脚本会自动在本机 `~/Library/Application Support/tphermes/` 创建 venv 和 DB。

**Q: 查看日志**
```
tail -f ~/Library/Application\ Support/tphermes/logs/backend.err.log
tail -f ~/Library/Application\ Support/tphermes/logs/frontend.err.log
```
