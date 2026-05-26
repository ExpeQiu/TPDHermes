# API 对照表（前缀：`/api/v1`）

所有业务路由均在 **`/api/v1`** 下（根路径 `/` 与 `/health` 除外）。

## 项目

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/projects/` | 列表 |
| POST | `/projects/` | 创建 |
| GET | `/projects/{id}` | 详情 |
| PUT | `/projects/{id}` | 更新 |
| DELETE | `/projects/{id}` | 删除 |

## 技能商店

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/skills/` | 已安装列表 |
| GET | `/skills/marketplace` | 市场目录（聚合全体用户已发布技能） |
| GET | `/skills/marketplace/categories` | 市场分类 |
| POST | `/skills/marketplace/install` | 从市场安装到当前用户技能仓库（支持同名自动副本） |
| POST | `/skills/` | 安装（body: `name`, `description`, `config?`, `source?`） |
| GET | `/skills/{name}` | 详情 |
| PATCH | `/skills/{name}/enable` | 启停 |
| PATCH | `/skills/{name}/config` | 配置 |
| DELETE | `/skills/{name}` | 卸载 |
| … | 版本相关 | 见 `backend/routes/skills_store.py` |

## 工坊

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/ws/generate` | SSE 流式生成（body: `skill_name`, `context`） |

## 知识库

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/kb/health` | 外部 KB / 缓存状态 |
| GET | `/kb/collections` | 集合列表 |
| GET | `/kb/collections/{name}/query` | GET 查询，`q`、`n` |
| POST | `/kb/query` | POST 查询 |
| GET | `/kb/cache/entries/{project_id}` | 缓存条目；`project_id` 为 `__all__` / `all` / `*` 时为跨项目汇总 |
| GET | `/kb/events` | SSE 订阅 |
| POST | `/kb/events/publish` | 内部推送测试 |

## 对话

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/chat/config` | 当前聊天承接模式与目标地址 |
| POST | `/chat/completions` | 统一聊天补全入口；默认由后端代理到本地 `Hermes-agent` |

## 系统

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 服务名 |
| GET | `/health` | 增强健康检查（包装为统一响应结构） |

## 飞书

见 `backend/routes/feishu.py`、`feishu_bot.py`（均在 `/api/v1/feishu`、`/api/v1/feishu-bot` 下）。
