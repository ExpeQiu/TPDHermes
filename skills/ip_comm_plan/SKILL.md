---
name: ip_comm_plan
description: 用于生成中文《技术IP传播策划方案》的 Python 类型技能。适用于技术IP发布、重大事件传播、项目概述、传播目标拆解、受众分层、内容渠道规划、传播节奏ROADMAP、预算明细和效果评估。
---

# 技术IP传播策划方案 Skill

## 目标

根据用户输入的传播背景、核心目标、关键信息、预算周期、受众分层、内容渠道、传播节奏和效果指标，生成符合平台标准模板的中文《技术IP传播策划方案》。

## 标准结构

本技能文件夹名固定为 `ip_comm_plan`，符合平台单个 Skill 目录规范：

```text
ip_comm_plan/
├── SKILL.md
├── references/
├── scripts/
├── templates/
└── assets/
```

## 使用流程

1. 识别行业趋势、竞争格局、启动原因、传播目标、目标用户和核心信息。
2. 参考 `references/report-fields.md` 理解各字段填写口径。
3. 按 `templates/ip_comm_plan.md` 的结构输出 Markdown 传播策划方案。
4. 如平台支持脚本执行，可调用 `scripts/generate_plan.py`，用 JSON 输入生成 Markdown。
5. 信息不足时使用“待补充”标记；不要编造预算、曝光量、投放资源或效果数据。
6. 输出应适合技术 IP 发布、重大事件传播、营销立项和执行排期。

## Python 脚本调用

```bash
python scripts/generate_plan.py --input input.json --output ip_comm_plan.md
```

## 输出要求

- 必须包含项目概述、传播策略及目标、传播节奏/ROADMAP、传播预算和效果评估四大章节。
- 传播目标、受众分层、传播内容、传播渠道、传播周期、预算明细、效果评估指标必须使用表格。
- 核心目标需体现 SMART 核查。
- 传播节奏需包含预热期、爆发期和延续期。

## 资源说明

- `references/report-fields.md`：字段说明和判断口径。
- `templates/ip_comm_plan.md`：标准 Markdown 模板。
- `scripts/generate_plan.py`：Python 生成脚本，使用标准库，无第三方依赖。
