---
name: event_plan_skill
description: 用于生成中文《技术推广活动策划方案》的 Python 类型技能。适用于车展、技术展会、线下活动策划，覆盖展会信息、策略展开、参展目标、传播规划、展台信息、时间节点、技术代言人安排和任务分工。
---

# 技术推广活动策划方案 Skill

## 目标

根据用户输入的展会背景、主题、参展目标、传播规划、展台信息、时间节点、人员安排和任务分工，生成符合平台标准模板的中文《技术推广活动策划方案》。

## 标准结构

本技能文件夹名固定为 `event_plan_skill`，符合平台单个 Skill 目录规范：

```text
event_plan_skill/
├── SKILL.md
├── references/
├── scripts/
├── templates/
└── assets/
```

## 使用流程

1. 识别展会主办方、主题、时间地点、展位面积、参展价值和策略目标。
2. 参考 `references/report-fields.md` 理解各字段填写口径。
3. 按 `templates/event_plan.md` 的结构输出 Markdown 策划方案。
4. 如平台支持脚本执行，可调用 `scripts/generate_plan.py`，用 JSON 输入生成 Markdown。
5. 信息不足时使用“待补充”标记；不要编造展会时间、展位信息、人员排期或量化指标。
6. 输出应适合车展、技术展会或线下活动的内部评审与执行落地。

## Python 脚本调用

```bash
python scripts/generate_plan.py --input input.json --output event_plan.md
```

## 输出要求

- 必须包含展会信息、策略展开、参展目标、传播目标及规划、展台信息、时间节点、技术代言人安排、任务分工。
- 量化目标、展台功能分区、展会时间节点、出席人员、总体分工必须使用表格。
- 传播规则需覆盖合规、竞品对比和敏感话题处理。
- 任务分工需明确部门、职责、核心任务和交付物。

## 资源说明

- `references/report-fields.md`：字段说明和判断口径。
- `templates/event_plan.md`：标准 Markdown 模板。
- `scripts/generate_plan.py`：Python 生成脚本，使用标准库，无第三方依赖。
