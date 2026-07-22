---
name: brand_research_report
description: 生成中文《技术品牌调研报告》（管理者摘要、核心发现、策略与执行建议）。当用户需要调研结案报告、调研发现沉淀、技术品牌策略依据时使用。
when: 调研报告 / 调研结案 / 研究发现 / 策略依据
---

## 何时调用

用户提到或隐含需要：调研报告 / 调研结案 / 研究发现 / 策略依据 时，优先调用本技能。

触发词：调研报告、调研结案、品牌调研报告、管理者摘要、研究发现。

# 技术品牌调研报告 Skill

## 目标

根据用户输入的调研背景、执行情况、样本信息、核心观点、研究发现、策略建议和执行建议，生成符合平台标准模板的中文《技术品牌调研报告》。

## 标准结构

本技能文件夹名固定为 `brand_research_report`，符合平台单个 Skill 目录规范：

```text
brand_research_report/
├── SKILL.md
├── references/
├── scripts/
├── templates/
└── assets/
```

## 使用流程

1. 识别启动背景、调研目的、期望解决的问题、执行时间、城市、方法和有效样本。
2. 参考 `references/report-fields.md` 理解各字段填写口径。
3. 按 `templates/research_report.md` 的结构输出 Markdown 调研报告。
4. 如平台支持脚本执行，可调用 `scripts/generate_report.py`，用 JSON 输入生成 Markdown。
5. 信息不足时使用“待补充”标记；不要编造数据、样本量、置信度或调研结论。
6. 输出应适合调研项目结案、管理层汇报和后续技术品牌策略制定。

## Python 脚本调用

```bash
python scripts/generate_report.py --input input.json --output research_report.md
```

## 输出要求

- 必须包含调研背景与研究概述、管理者摘要、核心研究发现、总结及建议、附录五大章节。
- 建议行动和执行建议必须使用表格。
- 核心观点建议 3-5 条；核心研究发现建议 3-4 条。
- 每条研究发现应包含数据/事实、分析解读和置信度。

## 资源说明

- `references/report-fields.md`：字段说明和判断口径。
- `templates/research_report.md`：标准 Markdown 模板。
- `scripts/generate_report.py`：Python 生成脚本，使用标准库，无第三方依赖。
