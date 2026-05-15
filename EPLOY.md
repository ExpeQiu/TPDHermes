# TPDHermes 云服务器部署指南

本文档面向目标服务器 `47.113.225.93`，对外服务访问入口定义为 `47.113.225.93:8033`，默认采用以下方式部署：

- 云服务器操作系统：Ubuntu 22.04/24.04
- 部署方式：`Docker Compose`
- 对外入口：`Nginx`，先使用 `http://47.113.225.93:8033`
- 服务拓扑：`nginx -> frontend -> backend -> hermes-agent`
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

TPDHERMES_FRONTEND_IMAGE=tphermes-frontend:prod
TPDHERMES_BACKEND_IMAGE=tphermes-backend:prod

FEISHU_APP_ID=
FEISHU_APP_SECRET=
```

注意：

- `NEXT_PUBLIC_API_URL` 必须是浏览器可访问的公网地址，这里先用 `http://47.113.225.93:8033`
- `CORS_ALLOWED_ORIGINS` 需要和前端访问地址一致
- 当前对外访问端口固定为 `8033`，因此公网 URL 都需要带上 `:8033`
- `HERMES_CHAT_API_KEY` 是 `TPDHermes backend` 调 `Hermes-agent` 时用的 key
- `HERMES_AGENT_API_SERVER_KEY` 是 `Hermes-agent` 本身的服务鉴权 key
- 如果两边走同一套 key，可以把这两个值设置成一样
- `CHROMA_HOST` 如果暂时没有知识库服务，请改成你实际可用的地址；没有可用服务时，知识库相关能力会受影响

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
      - PORT=8642
      - API_SERVER_KEY=${HERMES_AGENT_API_SERVER_KEY:-change-me}
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
docker logs hermes-agent --tail 100
```

### 7.3 验证前端是否正确走公网入口

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
