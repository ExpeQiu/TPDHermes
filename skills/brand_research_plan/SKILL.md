---
name: brand_research_plan
description: 用于生成中文《技术品牌调研计划》的 Python 类型技能。适用于技术品牌调研项目立项、供应商招标、调研背景目的、方法范围、样本规划、被访者要求、供应商要求、执行计划和预算规划。
---

# 技术品牌调研计划 Skill

## 目标

根据用户输入的调研背景、核心问题、调研方法、样本规划、供应商要求、执行排期和预算信息，生成符合平台标准模板的中文《技术品牌调研计划》。

## 标准结构

本技能文件夹名固定为 `brand_research_plan`，符合平台单个 Skill 目录规范：

```text
brand_research_plan/
├── SKILL.md
├── references/
├── scripts/
├── templates/
└── assets/
```

## 使用流程

1. 识别行业趋势背景、企业战略需求、启动调研动因、核心问题和策略输出期望。
2. 参考 `references/report-fields.md` 理解各字段填写口径。
3. 按 `templates/research_plan.md` 的结构输出 Markdown 调研计划。
4. 如平台支持脚本执行，可调用 `scripts/generate_plan.py`，用 JSON 输入生成 Markdown。
5. 信息不足时使用“待补充”标记；不要编造样本量、预算、供应商资质或调研结论。
6. 输出应适合项目立项、采购沟通和供应商招标。

## Python 脚本调用

```bash
python scripts/generate_plan.py --input input.json --output research_plan.md
```

## 输出要求

- 必须包含调研背景与目的、调研方法与范围、预算三大章节。
- 调研方法、覆盖区域、执行计划、预算分配参考必须使用表格。
- 样本规划需说明目标人群、细分市场、区域和样本量。
- 供应商要求需覆盖资质要求和团队要求。

## 资源说明

- `references/report-fields.md`：字段说明和判断口径。
- `templates/research_plan.md`：标准 Markdown 模板。
- `scripts/generate_plan.py`：Python 生成脚本，使用标准库，无第三方依赖。
