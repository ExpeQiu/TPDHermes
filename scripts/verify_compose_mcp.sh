#!/usr/bin/env bash
# 生产 Compose 下 MCP 与 KB 连通性自检（在部署机执行）
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
BACKEND="${BACKEND_CONTAINER:-tphermes-backend}"
MCP="${MCP_CONTAINER:-tphermes-mcp}"
AGENT="${AGENT_CONTAINER:-hermes-agent}"

echo "[verify-mcp] docker compose ps (mcp + agent)"
docker compose -f "$COMPOSE_FILE" ps "$MCP" "$AGENT" "$BACKEND" 2>/dev/null || docker ps --filter "name=$MCP" --filter "name=$AGENT"

echo "[verify-mcp] tphermes-mcp 内网 /mcp (expect 4xx, not connection refused)"
docker exec "$BACKEND" sh -c \
  'wget -q -S -O /dev/null http://tphermes-mcp:8801/mcp 2>&1 | head -5 || curl -s -o /dev/null -w "http_code=%{http_code}\n" http://tphermes-mcp:8801/mcp'

echo "[verify-mcp] backend MCP registry"
docker exec "$BACKEND" sh -c \
  'curl -s http://127.0.0.1:8000/api/v1/mcp/servers | head -c 400; echo'

echo "[verify-mcp] hermes mcp test (optional)"
if docker exec "$AGENT" sh -c 'command -v hermes >/dev/null 2>&1'; then
  docker exec "$AGENT" sh -lc 'hermes mcp list 2>/dev/null | head -20 || true'
  docker exec "$AGENT" sh -lc 'hermes mcp test tphermes 2>/dev/null || true'
else
  echo "[verify-mcp] hermes CLI not in image, skip mcp test"
fi

echo "[verify-mcp] KB health"
docker exec "$BACKEND" sh -c 'curl -s http://127.0.0.1:8000/api/v1/kb/health; echo'

echo "[verify-mcp] done (公网 8801 未暴露属正常，仅 Docker 内网访问 tphermes-mcp:8801)"
