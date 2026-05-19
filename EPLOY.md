# TPDHermes 云服务器部署指南

本文档面向目标服务器 `47.113.225.93`，对外服务访问入口定义为 `47.113.225.93:8033`，默认采用以下方式部署：

- 云服务器操作系统：Ubuntu 22.04/24.04
- 部署方式：`Docker Compose`
- 对外入口：`Nginx`，先使用 `http://47.113.225.93:8033`
- 服务拓扑：`nginx -> frontend -> backend -> hermes-agent -> tphermes-mcp`
- 数据存储：后端使用容器卷持久化 `SQLite`

如果后续切换到域名和 HTTPS，只需要更新 `.env` 中的公网访问地址，并在入口层补证书即可。当前容器内 `nginx` 监听 `80`，宿主机通过端口映射对外暴露 `8033`。

## 增量部署原则（日常更新必读）

日常发版与问题修复请遵守以下原则，避免无谓停机与长时间构建：

1. **非必要不要重新构建 `hermes-agent`**  
   - `hermes-agent` 使用 `docker-compose.src-hermes.yml` 时，镜像构建包含 `npm install`、`uv sync` 等步骤，通常需 **30 分钟以上**。  
   - 仅修改 TPDHermes 业务代码（`src/`、`backend/`、`skills/` 等）时，**不要**触发 Hermes 镜像构建。  
   - 仅当确实升级 Hermes 源码、`Dockerfile.alicloud` 或 Agent 依赖时，才单独执行 `build hermes-agent`。

2. **不要整体 `up -d --build` 所有服务**  
   - 避免 `docker compose ... up -d --build` 不带服务名，尤其在同时叠加 `docker-compose.src-hermes.yml` 时，会因依赖链误触发 `hermes-agent` 构建。  
   - **改哪部分就只构建、只重启那部分**（见下表）。

3. **变更范围与对应操作**

| 变更内容 | 需要构建 | 需要重启/拉起 |
| --- | --- | --- |
| 前端页面 `src/` | `frontend` | `frontend`、`nginx` |
| 后端 API `backend/` | `backend` | `backend` |
| 技能 `skills/` | `backend`、`tphermes-mcp` | `backend`、`tphermes-mcp` |
| `nginx/nginx.conf` | 否 | `nginx` |
| `deploy/hermes-agent/config.yaml` | 否 | `hermes-agent`（`restart` 即可） |
| Hermes 源码 / Agent Dockerfile | `hermes-agent` | `hermes-agent` |

4. **推荐：日常 TPDHermes 增量发布命令**（不构建 Hermes）

```bash
cd /opt/tpdhermes/TPDHermes

# 仅构建 TPDHermes 相关镜像（勿加 docker-compose.src-hermes.yml）
DOCKER_BUILDKIT=1 docker compose -f docker-compose.prod.yml build frontend backend tphermes-mcp

# 拉起变更服务；hermes-agent 使用已有镜像，--no-build 禁止误触发构建
docker compose -f docker-compose.prod.yml -f docker-compose.src-hermes.yml \
  up -d --no-build frontend backend tphermes-mcp nginx hermes-agent
```

按变更裁剪服务名，例如只改前端：

```bash
docker compose -f docker-compose.prod.yml build frontend
docker compose -f docker-compose.prod.yml -f docker-compose.src-hermes.yml up -d --no-build frontend nginx
```

仅更新 Hermes 配置（不构建镜像）：

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.src-hermes.yml restart hermes-agent
```

5. **本地上传代码时**  
   - `rsync` / `scp` 可排除 `hermes-agent/` 目录，除非本次确需升级 Agent 源码。  
   - 服务器上的 `.env` 不要被本地 `.env.local` 覆盖。

6. **仅首次上线或 Hermes 大版本升级** 才使用全量构建（见 §6「首次全量部署」）。

## 1. 服务器准备

### 1.1 登录服务器

```bash
ssh root@47.113.225.93
```

如果你使用非 root 账号：

```bash
ssh <your-user>@47.113.225.93
```

### 1.2 安装 Docker 和 Compose

```bash
apt update
apt install -y ca-certificates curl gnupg lsb-release
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  tee /etc/apt/sources.list.d/docker.list > /dev/null
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable docker
systemctl start docker
docker --version
docker compose version
```

### 1.3 开放安全组端口

至少放行以下端口：

- `22`：SSH
- `8033`：HTTP

如果后面要启用 HTTPS，再放行：

- `443`：HTTPS

## 2. 上传项目

建议部署目录：

```bash
mkdir -p /opt/tpdhermes
cd /opt/tpdhermes
```

如果直接从 Git 拉取：

```bash
git clone <你的仓库地址> TPDHermes
cd /opt/tpdhermes/TPDHermes
```

如果你从本地上传代码：

```bash
scp -r /本地路径/TPDHermes root@47.113.225.93:/opt/tpdhermes/
```

如果 `Hermes-agent` 不是远程镜像，而是本地源码构建，也一起上传到 `/opt/tpdhermes/Hermes-agent`。

## 3. 核对部署文件

当前仓库已经准备好以下生产部署文件：

- `docker-compose.prod.yml`
- `docker-compose.yml`
- `docker-compose.src-hermes.yml`
- `nginx/nginx.conf`
- `.env.production.example`
- `deploy/hermes-agent/config.yaml`
- `deploy/hermes-agent/SOUL.md`

其中：

- `docker-compose.prod.yml` 是显式的生产版编排文件
- `docker-compose.yml` 已同步为生产拓扑，可直接作为默认启动入口
- `nginx/nginx.conf` 负责反向代理前后端

## 4. 配置生产环境变量

进入项目目录：

```bash
cd /opt/tpdhermes/TPDHermes
cp .env.production.example .env
```

然后编辑 `.env`：

```bash
vim .env
```

首次按 IP 部署时，建议修改成下面这样：

```env
PUBLIC_DOMAIN=47.113.225.93:8033
PUBLIC_ORIGIN=http://47.113.225.93:8033

NEXT_PUBLIC_API_URL=http://47.113.225.93:8033
NEXT_PUBLIC_USE_MOCK_KB=

DATABASE_URL=sqlite+aiosqlite:////app/data/tphermes.db
CORS_ALLOWED_ORIGINS=http://47.113.225.93:8033
CHROMA_HOST=http://your-chroma-host:8001
HERMES_CHAT_API_URL=http://hermes-agent:8642/v1/chat/completions
HERMES_CHAT_API_KEY=请替换为真实值
HERMES_CHAT_MODEL=hermes-agent

HERMES_AGENT_IMAGE=ghcr.io/your-org/hermes-agent:latest
HERMES_AGENT_API_SERVER_KEY=请替换为真实值
MINIMAX_CN_API_KEY=请替换为真实值
MINIMAX_CN_BASE_URL=https://api.minimaxi.com/anthropic
TAVILY_API_KEY=请替换为真实值
TAVILY_REMOTE_MCP_URL=https://mcp.tavily.com/mcp/

TPDHERMES_FRONTEND_IMAGE=tphermes-frontend:prod
TPDHERMES_BACKEND_IMAGE=tphermes-backend:prod

FEISHU_APP_ID=
FEISHU_APP_SECRET=

TPDHERMES_MCP_HOST=0.0.0.0
TPDHERMES_MCP_PORT=8801
TPDHERMES_MCP_PATH=/mcp
TPDHERMES_MCP_TRANSPORT=streamable-http
TPDHERMES_MCP_LOG_LEVEL=info
TPDHERMES_MCP_URL=http://tphermes-mcp:8801/mcp
```

注意：

- `NEXT_PUBLIC_API_URL` 必须是浏览器可访问的公网地址，这里先用 `http://47.113.225.93:8033`
- `CORS_ALLOWED_ORIGINS` 需要和前端访问地址一致
- 当前对外访问端口固定为 `8033`，因此公网 URL 都需要带上 `:8033`
- `HERMES_CHAT_API_KEY` 是 `TPDHermes backend` 调 `Hermes-agent` 时用的 key
- `HERMES_AGENT_API_SERVER_KEY` 是 `Hermes-agent` 本身的服务鉴权 key
- 如果两边走同一套 key，可以把这两个值设置成一样
- 如果 `Hermes-agent` 走 MiniMax 中国区，请直接使用标准变量名 `MINIMAX_CN_API_KEY`
- MiniMax 中国区 Anthropic 兼容地址建议固定写成 `MINIMAX_CN_BASE_URL=https://api.minimaxi.com/anthropic`
- 如果你希望 `Hermes-agent` 具备 Tavily 联网能力，建议同时在项目 `.env` 中维护 `TAVILY_API_KEY`
- 当前推荐方式不是让 `Hermes-agent` 直接启用 Tavily `web backend`，而是让 `tphermes-mcp` 代理 Tavily Remote MCP，再由 `Hermes-agent` 通过 `TPDHERMES_MCP_URL` 统一调用
- `CHROMA_HOST` 如果暂时没有知识库服务，请改成你实际可用的地址；没有可用服务时，知识库相关能力会受影响
- `TPDHERMES_MCP_URL` 默认走容器内网地址，供 `Hermes-agent` 通过 MCP 调用 `TPDHermes` 的 KB、Workshop、Project 工具
- `TPDHERMES_MCP_PATH` 需要与 `tphermes-mcp` 服务启动参数保持一致，默认使用 `/mcp`

如果你希望把当前生产环境也标准化为 MiniMax 中国区，建议同时把 `Hermes-agent` 数据卷中的 `config.yaml` 设为：

```yaml
model:
  default: "MiniMax-M2.7-highspeed"
  provider: "minimax-cn"
  base_url: "https://api.minimaxi.com/anthropic"
```

这样后续即使重建容器，只要项目 `.env` 仍保留 `MINIMAX_CN_API_KEY/MINIMAX_CN_BASE_URL`，就不需要再做自定义变量映射。

如果你同时希望把联网搜索能力也标准化，建议把 Tavily 的来源统一收敛到 `tphermes-mcp`：

- `tphermes-mcp` 读取 `TAVILY_API_KEY`
- `tphermes-mcp` 读取 `TAVILY_REMOTE_MCP_URL`
- `tphermes-mcp` 在启动时挂载 Tavily Remote MCP
- `Hermes-agent` 只连接 `TPDHERMES_MCP_URL=http://tphermes-mcp:8801/mcp`

这样后续即使迁移机器或重建容器，只要项目 `.env` 仍保留 `TAVILY_API_KEY`，Hermes 仍可通过 `mcp_tphermes_*` 方式继续使用 Tavily 提供的联网工具。

当前推荐的生产收口策略是：

- 由 `tphermes-mcp` 统一代理 Tavily Remote MCP
- `Hermes-agent` 通过 `mcp_servers.tphermes.tools.include` 只开放 `tavily_search` 与 `tavily_extract`
- `tavily_crawl / tavily_map / tavily_research` 默认先不暴露，避免模型在生产环境里无约束地扩大搜索面

对应的 `config.yaml` 建议写成：

```yaml
mcp_servers:
  tphermes:
    url: http://tphermes-mcp:8801/mcp
    enabled: true
    timeout: 120
    connect_timeout: 30
    tools:
      include:
        - kb_query
        - kb_list_collections
        - kb_get_entry
        - workshop_list_skills
        - workshop_get_skill_info
        - workshop_generate
        - workshop_generate_from_kb
        - project_list
        - project_create
        - project_get
        - tavily_search
        - tavily_extract
        - list_resources
        - read_resource
        - list_prompts
        - get_prompt
```

如果飞书群里希望机器人在**不需要 `@`** 的情况下也能回复，请再补上：

```yaml
platforms:
  feishu:
    extra:
      require_mention: false
```

生产部署时，Agent 会频繁执行 `curl`、`ssh`、`docker compose` 等运维命令。默认的 **Tirith 安全扫描** 与 **Command Approval Required** 交互审批会导致每次命令都弹窗确认。在可信的自建服务器上，建议在 `deploy/hermes-agent/config.yaml` 中关闭交互审批：

```yaml
# 生产部署：关闭命令交互审批（硬线 blocklist 仍生效，如 rm -rf /、fork bomb）
approvals:
  mode: off
  timeout: 90

security:
  tirith_enabled: false
```

运维建议：

- 健康检查优先用**容器内网地址**（如 `http://backend:8000/...`、`http://tphermes-mcp:8801/...`），避免 `http://47.113.225.93:8033/...` 触发 Tirith 对裸 IP / 明文 HTTP 的告警
- 如需 SSH 到宿主机，优先配置 `terminal.backend: ssh` + 密钥（`TERMINAL_SSH_HOST` / `TERMINAL_SSH_USER` / `TERMINAL_SSH_KEY` 写在 `/opt/data/.env`），不要用 `sshpass` 明文密码
- 若仍希望保留部分审批，可改为 `approvals.mode: smart`，或在飞书会话里发 `/yolo` 临时放行

对应挂载到容器内的路径是 `/opt/data/config.yaml`。修改后重启 `hermes-agent` 即可生效：

```bash
cd /opt/tpdhermes/TPDHermes
docker compose -f docker-compose.prod.yml -f docker-compose.src-hermes.yml restart hermes-agent
```

从本地上传配置后生效：

```bash
scp deploy/hermes-agent/config.yaml root@47.113.225.93:/opt/tpdhermes/TPDHermes/deploy/hermes-agent/config.yaml
ssh root@47.113.225.93 'cd /opt/tpdhermes/TPDHermes && docker compose -f docker-compose.prod.yml -f docker-compose.src-hermes.yml restart hermes-agent'
```

验证容器内配置已加载：

```bash
docker exec hermes-agent sh -lc 'grep -A3 "^approvals:" /opt/data/config.yaml; grep -A2 "^security:" /opt/data/config.yaml'
```

如果后续确认需要开放更强的联网能力，再按需把 `tavily_crawl / tavily_map / tavily_research` 加回 `include` 白名单。

## 5. Hermes-agent 接入方式

### 方案 A：Hermes-agent 使用远程镜像

如果你已经把 `Hermes-agent` 发布到镜像仓库，只需要在 `.env` 里设置：

```env
HERMES_AGENT_IMAGE=ghcr.io/your-org/hermes-agent:latest
```

这是当前 `docker-compose.prod.yml` 的默认模式。

### 方案 B：Hermes-agent 使用本地源码构建

如果 `Hermes-agent` 源码放在 **TPDHermes 仓库内**（推荐路径 `hermes-agent/hermes-agent-main/`，与官方 Dockerfile 同级），可直接使用仓库里的 **`docker-compose.src-hermes.yml`** 覆盖构建，无需手改 `image`。

首次或升级 Agent 时单独构建（日常 TPDHermes 更新见文首 **「增量部署原则」**）：

```bash
DOCKER_BUILDKIT=1 docker compose -f docker-compose.prod.yml -f docker-compose.src-hermes.yml build hermes-agent
docker compose -f docker-compose.prod.yml -f docker-compose.src-hermes.yml up -d --no-build hermes-agent
```

若 Hermes 与 TPDHermes **并列目录**（例如 `/opt/tpdhermes/Hermes-agent`），则把 `docker-compose.prod.yml` 里的 `hermes-agent` 从 `image` 改为 `build`：

```yaml
  hermes-agent:
    build:
      context: ../Hermes-agent
      dockerfile: Dockerfile
    container_name: hermes-agent
    restart: unless-stopped
    environment:
      - HERMES_UID=${HERMES_UID:-10000}
      - HERMES_GID=${HERMES_GID:-10000}
      - API_SERVER_ENABLED=true
      - API_SERVER_HOST=0.0.0.0
      - API_SERVER_PORT=8642
      - PORT=8642
      - API_SERVER_KEY=${HERMES_AGENT_API_SERVER_KEY:-change-me}
      - MINIMAX_CN_API_KEY=${MINIMAX_CN_API_KEY:-}
      - MINIMAX_CN_BASE_URL=${MINIMAX_CN_BASE_URL:-}
    expose:
      - "8642"
    networks:
      - tphermes-net
```

如果 `Hermes-agent` 的 Dockerfile、启动命令或环境变量名不同，需要按它自己的仓库实际情况调整。

## 6. 构建并启动

### 6.1 首次全量部署

仅**第一次**在服务器上架、或需要一次性拉起全部容器时使用。日常更新请改走上文 **「增量部署原则」**，不要重复全量 `--build`。

```bash
cd /opt/tpdhermes/TPDHermes
# 若 Hermes 走仓库内源码，首次需构建 Agent（耗时长，仅首次或升级 Agent 时执行）
DOCKER_BUILDKIT=1 docker compose -f docker-compose.prod.yml -f docker-compose.src-hermes.yml build hermes-agent
DOCKER_BUILDKIT=1 docker compose -f docker-compose.prod.yml build frontend backend tphermes-mcp
docker compose -f docker-compose.prod.yml -f docker-compose.src-hermes.yml up -d --no-build
```

若 Hermes 使用远程镜像、无需本地构建，可简化为：

```bash
cd /opt/tpdhermes/TPDHermes
docker compose -f docker-compose.prod.yml up -d --build
```

### 6.2 日常增量部署

见上文 **「增量部署原则」**；默认只 `build` + `up --no-build` 本次变更涉及的服务。

查看容器状态：

```bash
docker compose -f docker-compose.prod.yml ps
```

查看实时日志：

```bash
docker compose -f docker-compose.prod.yml logs -f
```

如果你后续只维护默认 `docker-compose.yml`，日常同样**不要**无差别全量 `--build`，应按变更服务名单独构建（原则同上）。

## 7. 部署后验证

### 7.1 健康检查

在服务器本机执行：

```bash
curl http://127.0.0.1:8033/health
curl http://127.0.0.1:8033/api/v1/chat/config
```

在本地浏览器访问：

- `http://47.113.225.93:8033`
- `http://47.113.225.93:8033/health`
- `http://47.113.225.93:8033/api/v1/chat/config`

### 7.2 单独检查容器

```bash
docker ps
docker logs tphermes-nginx --tail 100
docker logs tphermes-frontend --tail 100
docker logs tphermes-backend --tail 100
docker logs tphermes-mcp --tail 100
docker logs hermes-agent --tail 100
```

### 7.3 验证 MCP 是否接通

进入 `hermes-agent` 容器：

```bash
docker exec -it hermes-agent sh
```

先确认配置已经挂载：

```bash
cat /opt/data/config.yaml
```

再测试 MCP 服务发现：

```bash
hermes mcp list
hermes mcp test tphermes
```

如果返回 `kb_query`、`workshop_list_skills`、`project_list` 等工具，说明 `Hermes-agent -> TPDHermes MCP` 已经打通。

如果 `hermes mcp list` 正常，但你仍想确认 `gateway` 主进程已经加载了 `tphermes`，请额外检查持久化日志：

```bash
docker exec hermes-agent sh -lc "grep -n 'MCP server .*tphermes\\|MCP:' /opt/data/logs/agent.log | tail -n 20"
```

正常情况下会看到类似：

```text
INFO tools.mcp_tool: MCP server 'tphermes' (HTTP): registered 16 tool(s): ...
INFO tools.mcp_tool: MCP: registered 16 tool(s) from 1 server(s)
```

注意：这类注册日志不一定会稳定出现在 `docker logs hermes-agent` 标准输出里，更可靠的位置是 `/opt/data/logs/agent.log`。

如果你已经切到 Tavily MCP 白名单模式，日志里应看到：

```text
mcp_tphermes_tavily_search
mcp_tphermes_tavily_extract
```

且不应再看到：

```text
mcp_tphermes_tavily_crawl
mcp_tphermes_tavily_map
mcp_tphermes_tavily_research
```

### 7.4 验证前端是否正确走公网入口

打开页面后，在浏览器开发者工具里确认：

- 页面请求的是 `http://47.113.225.93:8033/api/v1/...`
- 不是 `http://localhost:8000/...`

如果仍然出现 `localhost:8000`，说明前端镜像没有重新构建，只需重建前端：

```bash
docker compose -f docker-compose.prod.yml build frontend
docker compose -f docker-compose.prod.yml -f docker-compose.src-hermes.yml up -d --no-build frontend nginx
```

## 8. 日常维护命令

重启**单个**服务（优先于全量 `restart`）：

```bash
docker compose -f docker-compose.prod.yml restart backend
docker compose -f docker-compose.prod.yml -f docker-compose.src-hermes.yml restart hermes-agent
```

停止服务：

```bash
docker compose -f docker-compose.prod.yml down
```

停止并**按需**无缓存重建（仅针对出问题的服务，勿默认全栈 `--no-cache`）：

```bash
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml build --no-cache frontend backend tphermes-mcp
docker compose -f docker-compose.prod.yml -f docker-compose.src-hermes.yml up -d --no-build
```

更新代码后重新部署（**增量**，不构建 Hermes）：

```bash
cd /opt/tpdhermes/TPDHermes
git pull
DOCKER_BUILDKIT=1 docker compose -f docker-compose.prod.yml build frontend backend tphermes-mcp
docker compose -f docker-compose.prod.yml -f docker-compose.src-hermes.yml \
  up -d --no-build frontend backend tphermes-mcp nginx hermes-agent
```

## 9. 回滚建议

如果本次更新后异常，建议按下面顺序回滚：

1. 切回上一个 Git 提交
2. 保留 `.env` 不变
3. 仅对回滚涉及的服务重新 `build` + `up --no-build`（原则同增量部署）

示例：

```bash
cd /opt/tpdhermes/TPDHermes
git log --oneline -n 5
git checkout <上一个稳定提交>
docker compose -f docker-compose.prod.yml build frontend backend tphermes-mcp
docker compose -f docker-compose.prod.yml -f docker-compose.src-hermes.yml \
  up -d --no-build frontend backend tphermes-mcp nginx hermes-agent
```

如果你之后希望走更规范的回滚流程，建议改为固定镜像 tag 发布，而不是直接在服务器现拉代码构建。

## 10. 常见问题

### 10.1 页面打不开

优先检查：

- 云服务器安全组是否放行 `8033`
- `docker ps` 中 `tphermes-nginx` 是否在运行
- `docker logs tphermes-nginx --tail 100` 是否报错

### 10.2 前端能打开，但聊天失败

优先检查：

- `tphermes-backend` 是否正常启动
- `.env` 中 `HERMES_CHAT_API_URL` 是否正确
- `.env` 中 `HERMES_CHAT_API_KEY` 是否与 `Hermes-agent` 对应
- `hermes-agent` 容器是否真的监听 `8642`

### 10.3 后端启动失败，提示缺少 HERMES_CHAT_API_URL

说明 `.env` 未加载或变量未填写。先执行：

```bash
cat .env
docker compose -f docker-compose.prod.yml config | grep HERMES_CHAT_API_URL
```

### 10.4 知识库不可用

通常是 `CHROMA_HOST` 不可达。先执行：

```bash
docker exec -it tphermes-backend /bin/sh
```

进入容器后测试：

```bash
python - <<'PY'
import os
print(os.getenv("CHROMA_HOST"))
PY
```

如果是外部服务，请确认该地址从服务器网络可访问。

### 10.5 本地源码版 Hermes-agent 没有生效

如果线上实际使用的是本地源码构建的 `Hermes-agent`，只执行：

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

可能不会应用 `docker-compose.src-hermes.yml` 里的覆盖配置。此时会出现：

- `hermes-agent` 仍在跑旧镜像或占位镜像
- 新挂载的 `config.yaml`、新环境变量或新构建代码没有生效

正确做法：

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.src-hermes.yml config
docker compose -f docker-compose.prod.yml -f docker-compose.src-hermes.yml up -d --build
```

先用 `config` 看合并结果，再执行真正启动。

### 10.6 Gateway 未加载 MCP 配置

如果 `TPDHermes MCP` 服务已启动，但 `gateway` 仍像没接入一样，多半先看 `config.yaml` 是否能被 `hermes` 用户读取。

先检查权限：

```bash
stat -c "%A %U:%G %n" /opt/tpdhermes/TPDHermes/deploy/hermes-agent/config.yaml
docker exec hermes-agent sh -lc "stat -c '%A %U:%G %n' /opt/data/config.yaml"
```

宿主机挂载文件建议至少为：

```text
-rw-r--r-- root:root
```

如果权限过严，修复后重启：

```bash
chmod 644 /opt/tpdhermes/TPDHermes/deploy/hermes-agent/config.yaml
docker compose -f docker-compose.prod.yml -f docker-compose.src-hermes.yml restart hermes-agent
```

如果飞书群里出现“必须 `@` 机器人才能回复”，通常不是权限问题，而是 `platforms.feishu.extra.require_mention` 仍为默认值 `true`。建议直接检查宿主机和容器内的实际配置：

```bash
tail -n 8 /opt/tpdhermes/TPDHermes/deploy/hermes-agent/config.yaml
docker exec hermes-agent sh -lc "tail -n 8 /opt/data/config.yaml"
```

期望看到：

```yaml
platforms:
  feishu:
    extra:
      require_mention: false
```

如果宿主机文件已更新，但容器内还没变，说明挂载内容尚未重新加载，执行：

```bash
docker restart hermes-agent
```

异常日志通常会在 `/opt/data/logs/agent.log` 或 `docker logs hermes-agent` 里看到：

```text
Failed to parse /opt/data/config.yaml: [Errno 13] Permission denied
Failed to process config.yaml — falling back to .env / gateway.json values
```

### 10.7 MCP 已注册，但 `docker logs hermes-agent` 看不到

这不是一定代表没生效。`gateway` 和 `tools.mcp_tool` 的注册详情常常落在：

- `/opt/data/logs/agent.log`
- `/opt/data/logs/errors.log`

推荐检查：

```bash
docker exec hermes-agent sh -lc "grep -n 'tphermes\\|mcp_tphermes' /opt/data/logs/agent.log | tail -n 50"
```

今天实际验证时，`gateway` 启动后可以在 `agent.log` 中看到：

```text
INFO tools.mcp_tool: MCP server 'tphermes' (HTTP): registered 13 tool(s): ...
```

### 10.8 重建 Backend 后 `8033` 返回 502

如果你重建了 `tphermes-backend`，随后 `http://47.113.225.93:8033` 或 `curl http://127.0.0.1:8033/health` 突然变成 `502`，常见原因不是后端没起来，而是 `nginx` 仍缓存着旧的容器 IP。

修复方式：

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.src-hermes.yml up -d --force-recreate nginx
```

然后重新检查：

```bash
curl http://127.0.0.1:8033/health
curl http://127.0.0.1:8033/api/v1/chat/config
```

### 10.9 `config.yaml` 里不要写 shell 风格默认值

`Hermes-agent` 的 `config.yaml` 虽然支持部分环境变量展开，但不建议写 shell 风格的默认值表达式，例如：

```yaml
url: ${TPDHERMES_MCP_URL:-http://tphermes-mcp:8801/mcp}
```

更稳妥的写法是直接写明确地址：

```yaml
url: http://tphermes-mcp:8801/mcp
```

这样可以避免配置解析器不支持 `:-默认值` 语法时出现偏差。

### 10.10 真实聊天入口如何确认已经选用 `mcp_tphermes_kb_query`

推荐直接走真实聊天入口，而不是只做 `hermes mcp test`：

```bash
curl -sS -X POST http://127.0.0.1:8033/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model":"hermes-agent",
    "stream":false,
    "messages":[
      {
        "role":"user",
        "content":"请你必须调用 mcp_tphermes_kb_query 查询知识库集合 public.structured_tech.remote_debug，确认是否存在标题为 8033 远程联调文档 的内容。"
      }
    ]
  }'
```

再检查 `agent.log`：

```bash
docker exec hermes-agent sh -lc "grep -n 'mcp_tphermes_kb_query\\|tool mcp_tphermes_kb_query' /opt/data/logs/agent.log | tail -n 20"
```

今天实测可看到：

```text
INFO [api-...] run_agent: tool mcp_tphermes_kb_query completed (0.06s, 1970 chars)
```

这说明真实 `/chat` 会话里，模型不只是“看得到工具”，而是已经实际选用并执行了该 MCP KB 工具。

### 10.12 切换到 Tavily MCP

如果你已经在线上验证过 Tavily 直连可用，建议继续把它收敛到：

- `tphermes-mcp` 持有 `TAVILY_API_KEY`
- `tphermes-mcp` 挂载 Tavily Remote MCP
- `Hermes-agent` 不再直接持有 `TAVILY_API_KEY`
- `Hermes-agent` 只通过 `mcp_tphermes_*` 使用 Tavily 能力

推荐操作顺序：

1. 在项目 `.env` 中保留：

```env
TAVILY_API_KEY=请替换为真实值
TAVILY_REMOTE_MCP_URL=https://mcp.tavily.com/mcp/
```

2. 在 `deploy/hermes-agent/config.yaml` 中对 `tphermes` 增加 `tools.include`，只保留：

```yaml
- tavily_search
- tavily_extract
```

3. 重建并重启：

```bash
cd /opt/tpdhermes/TPDHermes
docker compose -f docker-compose.prod.yml -f docker-compose.src-hermes.yml build backend
docker compose -f docker-compose.prod.yml -f docker-compose.src-hermes.yml up -d --force-recreate backend tphermes-mcp hermes-agent
```

4. 清理 `Hermes-agent` 持久化环境中的旧 Tavily 变量，避免同时保留“直连 Tavily”和“MCP Tavily”两条入口：

```bash
docker exec hermes-agent sh -lc 'if [ -f /opt/data/.env ]; then grep -v -E "^(TAVILY_API_KEY|TAVILY_REMOTE_MCP_URL)=" /opt/data/.env > /opt/data/.env.clean && mv /opt/data/.env.clean /opt/data/.env; fi'
docker restart hermes-agent
```

5. 检查当前 `Hermes-agent` 运行环境中已不再持有 `TAVILY_*`：

```bash
docker exec hermes-agent sh -lc 'env | grep -E "^TAVILY_" || true; echo ---; [ -f /opt/data/.env ] && grep -E "^TAVILY_" /opt/data/.env || true'
```

6. 检查 MCP 工具注册结果：

```bash
docker exec hermes-agent sh -lc 'grep -nE "MCP server .*tphermes|MCP: registered .*tool\(s\)" /opt/data/logs/agent.log | tail -n 20'
```

正常情况下应看到 `registered 16 tool(s)`，并包含：

```text
mcp_tphermes_tavily_search
mcp_tphermes_tavily_extract
```

7. 用真实 `/chat` 验证模型已实际调用 Tavily MCP 工具：

```bash
curl -sS -X POST http://127.0.0.1:8033/api/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model":"hermes-agent",
    "stream":false,
    "messages":[
      {
        "role":"user",
        "content":"请必须使用 tphermes 里的 Tavily MCP 搜索工具查询 example.com 是什么网站，并用一句话回答。"
      }
    ]
  }'
```

再看日志：

```bash
docker exec hermes-agent sh -lc 'grep -n "tool mcp_tphermes_tavily_search completed" /opt/data/logs/agent.log | tail -n 5'
```

如果这里出现：

```text
INFO [api-...] run_agent: tool mcp_tphermes_tavily_search completed (...)
```

说明当前线上已经完全切换为 `TPDHermes MCP -> Tavily MCP` 路径。

### 10.13 Agent 执行命令反复弹出 `Command Approval Required`

现象：Agent 执行 `curl http://47.113.225.93:8033/...`、`curl | python3`、`sshpass ... ssh` 等命令时，飞书或 Web UI 反复弹出 **Command Approval Required**，提示 Tirith 扫描到裸 IP、明文 HTTP、管道到解释器等风险。

原因：`deploy/hermes-agent/config.yaml` 默认 `terminal.backend: local`，且未关闭 `approvals` / `tirith` 时，Hermes-agent 会对每条命令做预检并等待人工确认。

处理：确认 `deploy/hermes-agent/config.yaml` 已包含（见上文 §4）：

```yaml
approvals:
  mode: off
  timeout: 90

security:
  tirith_enabled: false
```

同步到服务器并重启：

```bash
scp deploy/hermes-agent/config.yaml root@47.113.225.93:/opt/tpdhermes/TPDHermes/deploy/hermes-agent/config.yaml
ssh root@47.113.225.93 'cd /opt/tpdhermes/TPDHermes && docker compose -f docker-compose.prod.yml -f docker-compose.src-hermes.yml restart hermes-agent'
```

验证：

```bash
docker exec hermes-agent sh -lc 'grep -A3 "^approvals:" /opt/data/config.yaml'
docker ps --filter name=hermes-agent --format "{{.Names}} {{.Status}}"
```

若配置已生效但仍偶发弹窗，可能是旧会话缓存了审批状态，重新发起一轮对话即可。

临时方案（不改配置）：在弹窗点 **Session** / **Always**，或在飞书发 `/yolo` 开启本会话自动批准。

### 10.11 直接上传 `skills/` 后，为什么 `/skills` 页面还是看不到

这是今天实际验证中最容易混淆的一点：

- `TPDHermes /workshop`、`SkillLoader.discover()`、`tphermes-mcp` 使用的是**代码目录发现**
- `/skills` 页面使用的是 **Skills Store / 技能商店** 接口
- 前端页面 `src/app/skills/page.tsx` 实际请求的是：

```text
GET /api/v1/skills/
```

也就是 Skills Store 数据库记录，而不是：

```text
GET /api/v1/ws/skills
```

因此如果你只是：

1. 把本地 `skills/` 目录上传到服务器仓库
2. 重建 `backend + tphermes-mcp`

那么结果会是：

- `SkillLoader.discover()` 能看到新 skill
- `mcp_tphermes_workshop_list_skills` 能看到新 skill
- 但 `/skills` 页面仍可能显示 `0`

原因是：**技能商店数据库里没有对应安装记录**。

可用的判断方法：

```bash
curl -sS http://127.0.0.1:8033/api/v1/skills/
curl -sS http://127.0.0.1:8033/api/v1/ws/skills
```

如果你看到：

- `/api/v1/skills/` 返回 `[]`
- 但 `workshop` 或 MCP 返回有 `a4_skill / benchmark_skill / ...`

说明问题不在前端渲染，而在于两套数据源不同。

要让 `/skills` 页面显示出来，推荐走 Skills Store 的正式安装链路：

- 页面上传 ZIP：`POST /api/v1/skills/upload`
- 或服务端调用 `SkillLifecycleService.install_from_zip_bytes(...)`

这样不仅把文件写入 `skills/`，还会同步写入技能商店数据库记录。

### 10.12 仅上传 `skills/` 目录后，为什么还必须重建 `backend + tphermes-mcp`

如果当前部署方式是 Docker 镜像内置 `skills/`，那么把文件上传到服务器仓库目录：

```text
/opt/tpdhermes/TPDHermes/skills
```

并不会自动影响运行中的容器。容器实际读取的是镜像内：

```text
/app/skills
```

所以只上传文件但不重建时，常见现象是：

- 服务器仓库目录已经有新 skill
- 但 `tphermes-backend` 容器里 `/app/skills` 仍是旧内容
- `workshop_list_skills` / `mcp_tphermes_workshop_list_skills` 仍只返回旧技能

正确做法：

```bash
cd /opt/tpdhermes/TPDHermes
docker compose -f docker-compose.prod.yml -f docker-compose.src-hermes.yml build backend
docker compose -f docker-compose.prod.yml -f docker-compose.src-hermes.yml up -d --force-recreate backend tphermes-mcp
```

今天实测就是在这一步之后，容器内 `/app/skills` 才从旧的 4 个技能更新为：

- `a4_skill`
- `benchmark_skill`
- `hello_skill`
- `ip_matrix_skill`
- `material_skill`
- `sales_skill`
- `speech_skill`
- `video_skill`

随后：

- `TPDHermes backend` 的 `SkillLoader.discover()` 返回 `count=8`
- `Hermes-agent` 通过 `tphermes MCP` 调用 `workshop_list_skills` 也返回 `count=8`

## 11. 后续升级到域名和 HTTPS

当前文档按 `http://47.113.225.93:8033` 部署，适合先快速跑通。

如果后续接入域名，例如 `https://hermes.example.com`，建议同步修改：

- `.env` 中 `PUBLIC_DOMAIN`
- `.env` 中 `PUBLIC_ORIGIN`
- `.env` 中 `NEXT_PUBLIC_API_URL`
- `.env` 中 `CORS_ALLOWED_ORIGINS`
- `Nginx` 改为监听 `443` 并挂载证书

改完后仅重新构建前端：

```bash
docker compose -f docker-compose.prod.yml build frontend
docker compose -f docker-compose.prod.yml up -d --no-build frontend nginx
```

## 12. 建议的首轮上线顺序

1. 在 `47.113.225.93` 安装 Docker 与 Compose
2. 上传 `TPDHermes` 和可选的 `Hermes-agent`
3. 复制 `.env.production.example` 为 `.env`
4. 按 IP 填好 `.env`，至少确认 `MINIMAX_CN_API_KEY`、`TAVILY_API_KEY`、`TAVILY_REMOTE_MCP_URL` 等关键项
5. 核对 `deploy/hermes-agent/config.yaml`（含 `approvals.mode: off` 与 `security.tirith_enabled: false`，见 §4）
6. 按 §6.1 **首次全量部署** 构建并启动（Hermes 仅首次或升级时构建）
7. 验证 `http://47.113.225.93:8033/health`
8. 此后日常发版遵循文首 **「增量部署原则」**，勿全栈 `up -d --build`
9. 打开首页并实际发一轮对话
10. 额外验证一次 `Hermes-agent` 是否能调用 `mcp_tphermes_*` 下的 Tavily 工具
