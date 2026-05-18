# TPDHermes 云服务器部署指南

本文档面向目标服务器 `47.113.225.93`，对外服务访问入口定义为 `47.113.225.93:8033`，默认采用以下方式部署：

- 云服务器操作系统：Ubuntu 22.04/24.04
- 部署方式：`Docker Compose`
- 对外入口：`Nginx`，先使用 `http://47.113.225.93:8033`
- 服务拓扑：`nginx -> frontend -> backend -> hermes-agent -> tphermes-mcp`
- 数据存储：后端使用容器卷持久化 `SQLite`

如果后续切换到域名和 HTTPS，只需要更新 `.env` 中的公网访问地址，并在入口层补证书即可。当前容器内 `nginx` 监听 `80`，宿主机通过端口映射对外暴露 `8033`。

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
- `nginx/nginx.conf`
- `.env.production.example`

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

## 5. Hermes-agent 接入方式

### 方案 A：Hermes-agent 使用远程镜像

如果你已经把 `Hermes-agent` 发布到镜像仓库，只需要在 `.env` 里设置：

```env
HERMES_AGENT_IMAGE=ghcr.io/your-org/hermes-agent:latest
```

这是当前 `docker-compose.prod.yml` 的默认模式。

### 方案 B：Hermes-agent 使用本地源码构建

如果 `Hermes-agent` 源码放在 **TPDHermes 仓库内**（推荐路径 `hermes-agent/hermes-agent-main/`，与官方 Dockerfile 同级），可直接使用仓库里的 **`docker-compose.src-hermes.yml`** 覆盖构建，无需手改 `image`：

```bash
docker compose -f docker-compose.yml -f docker-compose.src-hermes.yml up -d --build
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

推荐先用显式生产编排文件：

```bash
cd /opt/tpdhermes/TPDHermes
docker compose -f docker-compose.prod.yml up -d --build
```

查看容器状态：

```bash
docker compose -f docker-compose.prod.yml ps
```

查看实时日志：

```bash
docker compose -f docker-compose.prod.yml logs -f
```

如果你后续只维护默认 `docker-compose.yml`，也可以直接：

```bash
docker compose up -d --build
```

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
INFO tools.mcp_tool: MCP server 'tphermes' (HTTP): registered 13 tool(s): ...
INFO tools.mcp_tool: MCP: registered 13 tool(s) from 1 server(s)
```

注意：这类注册日志不一定会稳定出现在 `docker logs hermes-agent` 标准输出里，更可靠的位置是 `/opt/data/logs/agent.log`。

### 7.4 验证前端是否正确走公网入口

打开页面后，在浏览器开发者工具里确认：

- 页面请求的是 `http://47.113.225.93:8033/api/v1/...`
- 不是 `http://localhost:8000/...`

如果仍然出现 `localhost:8000`，说明前端镜像没有重新构建，需要重新执行：

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

## 8. 日常维护命令

重启服务：

```bash
docker compose -f docker-compose.prod.yml restart
```

停止服务：

```bash
docker compose -f docker-compose.prod.yml down
```

停止并删除镜像重新构建：

```bash
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml build --no-cache
docker compose -f docker-compose.prod.yml up -d
```

更新代码后重新部署：

```bash
cd /opt/tpdhermes/TPDHermes
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

## 9. 回滚建议

如果本次更新后异常，建议按下面顺序回滚：

1. 切回上一个 Git 提交
2. 保留 `.env` 不变
3. 重新执行 `docker compose -f docker-compose.prod.yml up -d --build`

示例：

```bash
cd /opt/tpdhermes/TPDHermes
git log --oneline -n 5
git checkout <上一个稳定提交>
docker compose -f docker-compose.prod.yml up -d --build
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

改完后重新构建前端：

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

## 12. 建议的首轮上线顺序

1. 在 `47.113.225.93` 安装 Docker 与 Compose
2. 上传 `TPDHermes` 和可选的 `Hermes-agent`
3. 复制 `.env.production.example` 为 `.env`
4. 按 IP 填好 `.env`
5. 执行 `docker compose -f docker-compose.prod.yml up -d --build`
6. 验证 `http://47.113.225.93:8033/health`
7. 打开首页并实际发一轮对话

如果你需要，我下一步可以继续补：

- `DEPLOY_HTTPS.md`，用于域名 + SSL 版本
- `deploy.sh`，一键部署脚本
- `systemd` 守护脚本或镜像发布规范
