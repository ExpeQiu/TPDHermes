#!/usr/bin/env bash
# 确保 Hermes Agent 可写输出目录（HERMES_HOME=/opt/data 生产环境）
set -euo pipefail

HERMES_HOME="${HERMES_HOME:-/opt/data}"

mkdir -p "${HERMES_HOME}/输出" "${HERMES_HOME}/output" "${HERMES_HOME}/workspace"
# workspace 内相对路径 输出/… 与绝对路径 /opt/data/输出/… 等价
ln -sfn "${HERMES_HOME}/输出" "${HERMES_HOME}/workspace/输出"

echo "[ensure-hermes-output-dirs] ok home=${HERMES_HOME} dirs=输出,output,workspace/输出"
