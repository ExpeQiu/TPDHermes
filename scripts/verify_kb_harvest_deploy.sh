#!/usr/bin/env bash
# 验收知识收割：MCP 是否暴露 kb_add_entry，Hermes 是否注册 mcp_tphermes_kb_add_entry
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COMPOSE_FILES=(-f docker-compose.prod.yml)
if [[ -f docker-compose.src-hermes.yml ]]; then
  COMPOSE_FILES+=(-f docker-compose.src-hermes.yml)
fi

dc() { docker compose "${COMPOSE_FILES[@]}" "$@"; }

echo "[verify_kb_harvest] 1/3 tphermes-mcp 进程内是否定义 kb_add_entry"
if ! dc exec -T tphermes-mcp python -c "import backend.mcp_server as m; assert hasattr(m,'kb_add_entry'), 'missing kb_add_entry'"; then
  echo "FAIL: tphermes-mcp 镜像过旧，请重建 backend + tphermes-mcp"
  exit 1
fi
echo "OK: mcp_server.kb_add_entry 存在"

echo "[verify_kb_harvest] 2/3 deploy/hermes-agent/config.yaml 是否白名单 kb_add_entry"
if ! grep -q 'kb_add_entry' deploy/hermes-agent/config.yaml; then
  echo "FAIL: config.yaml tools.include 缺少 kb_add_entry"
  exit 1
fi
echo "OK: config.yaml 已包含 kb_add_entry"

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
