# TPDHermes Backend

## FastMCP 版本状态

**状态：未安装（当前环境）**

当前运行环境中未检测到 FastMCP（`pip show fastmcp` 返回空）。

### 降级方案

如后续集成 MCP 功能时遇到兼容性问题，建议：

1. **锁定版本**：使用 `fastmcp>=0.9.0,<1.0.0` 而非最新大版本
2. **环境隔离**：在 `requirements.txt` 中单独维护 MCP 依赖，避免与主依赖链冲突
3. **虚拟环境**：使用 `uv` 或 `venv` 隔离 MCP 运行环境

```txt
# requirements-mcp.txt（可选）
fastmcp>=0.9.0,<1.0.0
```

## 启动方式

业务 API 统一前缀：`/api/v1`（根 `/` 与 `/health` 除外）。详见 [guide/API对照表.md](guide/API对照表.md)。

### 本地开发
```bash
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

### Docker
```bash
docker compose up --build
```

后端镜像使用根目录 [backend.Dockerfile](backend.Dockerfile)。

## API 文档

启动后访问：http://localhost:8000/docs
