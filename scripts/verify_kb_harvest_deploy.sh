#!/usr/bin/env bash
# 验收知识收割：MCP 是否暴露 kb_add_entry，Hermes 是否注册 mcp_tphermes_kb_add_entry
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COMPOSE_FILES=(-f docker-compose.prod.yml)
if [[ -f docker-compose.src-hermes.yml ]]; then
  COMPOSE_FILES+=(-f docker-compose.src-hermes.yml)
fi
# 端口覆盖（chroma 宿主机 8000 -> 8100，避让原生 uvicorn）：
# 显式 -f 时 compose 不会自动加载 *.override.yml，必须显式追加。
if [[ -f docker-compose.prod.override.yml ]]; then
  COMPOSE_FILES+=(-f docker-compose.prod.override.yml)
fi
if [[ -f docker-compose.fix-heartbeat.yml ]]; then
  COMPOSE_FILES+=(-f docker-compose.fix-heartbeat.yml)
fi

dc() { docker compose "${COMPOSE_FILES[@]}" "$@"; }

echo "[verify_kb_harvest] 1/3 tphermes-mcp 进程内是否定义 kb_add_entry"
if ! dc exec -T tphermes-mcp python -c "import backend.mcp_server as m; assert hasattr(m,'kb_add_entry'), 'missing kb_add_entry'"; then
  echo "FAIL: tphermes-mcp 镜像过旧，请重建 backend + tphermes-mcp"
  exit 1
fi
echo "OK: mcp_server.kb_add_entry 存在"

echo "[verify_kb_harvest] 2/3 共创热路径不挂 kb_add_entry，检索工具仍在"
if grep -q 'kb_add_entry' deploy/hermes-agent/config.yaml; then
  echo "FAIL: config.yaml 仍把 kb_add_entry 放进每轮工具定义"
  exit 1
fi
if ! grep -q 'kb_query' deploy/hermes-agent/config.yaml; then
  echo "FAIL: config.yaml tools.include 缺少 kb_query"
  exit 1
fi
echo "OK: 热路径保留 kb_query，未挂 kb_add_entry"

echo "[verify_kb_harvest] 3/3 hermes-agent 是否已注册 mcp_tphermes_kb_add_entry（查 agent.log）"
if dc ps --status running hermes-agent 2>/dev/null | grep -q hermes-agent; then
  if dc exec -T hermes-agent sh -lc "grep -q 'kb_add_entry' /opt/data/logs/agent.log 2>/dev/null"; then
    echo "OK: agent.log 出现过 kb_add_entry 相关记录"
  else
    echo "WARN: agent.log 未找到 kb_add_entry，请 restart hermes-agent 或发一条「请列出 tphermes MCP 工具」触发重载"
    dc exec -T hermes-agent sh -lc "grep -n \"MCP server 'tphermes'\" /opt/data/logs/agent.log 2>/dev/null | tail -n 3" || true
  fi
else
  echo "SKIP: hermes-agent 未运行"
fi

echo "[verify_kb_harvest] 完成"
