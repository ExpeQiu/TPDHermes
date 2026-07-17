---
name: multi-agent
description: 多模式 Agent 协作 CLI，支持圆桌辩论、主控+专家 Consult、并行 Swarm(STORM)，可作为智能体超级外挂
version: 0.1.0
metadata:
  cli_command: multi-agent
  requires_install: true
  agent_safe_commands:
    - run-start
    - mode-roundtable
    - mode-consult
    - mode-swarm
    - run-status
    - run-trajectory
    - run-resume
    - run-list
    - run-export
    - pack-list
    - pack-show
    - role-list
    - role-show
    - skill-list
    - skill-show
    - knowledge-list
    - doctor
    - config-show
  human_required_commands:
    - config-init
    - pack-save
    - role-save
    - role-delete
    - skill-save
    - skill-import
    - skill-delete
---

# multi-agent

多模式协作运行时：A 圆桌 / B Consult / C Swarm。数据走 stdout，日志走 stderr。

## 前置条件

```bash
pip install -e ".[dev]"
multi-agent --version
./verify.sh
```

配置优先级：CLI 参数 > 环境变量 `MULTI_AGENT_*` > `~/.multi-agent/config.yaml` > `./config.yaml`。

离线 Mock：`--demo` 或 `MULTI_AGENT_MOCK_MODE=true`。

## Agent 推荐命令

### 自动选型启动（agent_safe: true）

```bash
multi-agent run start --goal "半固态电池包装成抖音脚本" --mode auto --pack nev-tech --format json --demo
```

- 退出码：0 成功 / 2 无交付 / 3 执行失败 / 1 参数错误
- JSON 字段：`module`, `data_source`, `run_id`, `mode`, `coordinator`, `delivery`

### 圆桌（agent_safe: true）

```bash
multi-agent mode roundtable --topic "参数内卷下如何推技术" --pack nev-tech --rounds 2 --format markdown --demo
```

### Consult 主控+专家（agent_safe: true）

```bash
multi-agent mode consult --goal "半固态电池包装成抖音脚本" --pack nev-tech --format json --demo
```

### Swarm / STORM（agent_safe: true；大任务建议 background）

```bash
multi-agent mode swarm --goal "对比三家固态电池供应链风险" --max-parallel 5 --format json --demo
```

### 运行发现与导出（agent_safe: true）

```bash
multi-agent run list --format json
multi-agent run status <run_id> --format json
multi-agent run trajectory <run_id> --format markdown
multi-agent run export <run_id> --what delivery --format markdown
multi-agent run resume <run_id> --format json --demo
```

### 资源发现（agent_safe: true）

```bash
multi-agent pack list --format json
multi-agent pack show nev-tech --format json
multi-agent role list --format json
multi-agent skill list --format json
multi-agent knowledge list --format json
multi-agent doctor --format json
```

## 长任务说明

`mode swarm` 或复杂 `run start` 可能较久；Agent 平台可用 `sessions_spawn` / 后台执行，避免前台无限等待。可用 `run list` / `run status` / `run trajectory` 轮询。

## 禁止 Agent 自动调用

| 命令 | 原因 |
|------|------|
| `config init` | 写入用户级配置目录，建议人工确认 |
| `pack save` / `role save|delete` / `skill save|import|delete` | 改写仓库资源，需人工确认 |
| 未授权修改 `MULTI_AGENT_API_KEY` | 涉及密钥 |

## 输出解析

- stdout：`--format json|markdown|table` 的业务数据
- stderr：进度与日志（含 `run_id`）
- 交付唯一面：JSON 的 `delivery` 对象
- 列表类：JSON 含 `module` / `items` / `count`
