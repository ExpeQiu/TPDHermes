# multi-agent

多模式 Agent 协作运行时（圆桌 / 主控 Consult / Swarm STORM），CLI 对齐《CLI标准》，可作为智能体超级外挂。

## 安装

```bash
cd multi-agent
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
multi-agent --version
# 或直接：./verify.sh（会自动创建 .venv）
```

## 快速开始

```bash
# 自动选型
multi-agent run start --goal "半固态电池包装成抖音脚本" --mode auto --format json --demo

# 圆桌
multi-agent mode roundtable --topic "参数内卷下如何推" --pack nev-tech --format markdown --demo

# Consult
multi-agent mode consult --goal "半固态电池包装成抖音脚本" --format json --demo

# Swarm
multi-agent mode swarm --goal "对比三家固态电池供应链" --max-parallel 5 --format json --demo

# 资源发现
multi-agent pack list --format json
multi-agent role list --format json
multi-agent skill list --format json
multi-agent knowledge list --format json
multi-agent doctor --format json

# 运行历史
multi-agent run list --format json
multi-agent run trajectory <run_id> --format markdown
multi-agent run export <run_id> --what delivery --format markdown
```

## 配置

优先级：**CLI 参数 > 环境变量 > `~/.multi-agent/config.yaml` / `./config.yaml` > 默认值**

| 变量 | 说明 |
|------|------|
| `MULTI_AGENT_MOCK_MODE` | `true` 等价 `--demo` |
| `MULTI_AGENT_API_KEY` | live LLM 密钥 |
| `MULTI_AGENT_API_BASE` | OpenAI 兼容 base |
| `MULTI_AGENT_MODEL` | 模型名 |
| `MULTI_AGENT_RUNS_DIR` | 运行产物目录 |

参见 `.env.example`、`config.yaml.example`。

```bash
multi-agent config init
multi-agent config show --format json
```

## Web 前端

```bash
./scripts/start.sh   # launchd 常驻 KeepAlive → http://127.0.0.1:8765/
./scripts/stop.sh
```

**与 Cursor Agent 的关系：** Agent 会话里 `nohup`/`&` 拉起的进程常被会话结束回收，会导致 Simple Browser 出现 `ERR_CONNECTION_REFUSED`。请始终用 `./scripts/start.sh`（写入 `~/Library/LaunchAgents/com.multi-agent.web.plist`），再用系统浏览器或 Simple Browser 打开上述地址。

运行镜像在本机：`~/Library/Application Support/multi-agent/`（避免外置盘路径空格导致 launchd `EX_CONFIG`）。

## Agent 接入

- `SKILL.md`：Agent Skills 操作指南
- `agent/manifest.json`：机器可读命令 Schema

## 开发与验证

```bash
./verify.sh
```

覆盖：`--version` / `--help`、三模式 `--demo`、JSON 契约、资源 list、doctor、status/trajectory、pytest。

## 文档

见 `guide/`：产品定位、架构总览、CLI 标准对齐说明。
