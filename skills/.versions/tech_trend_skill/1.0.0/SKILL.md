---
name: tech_trend_skill
description: 用于生成中文《技术发展趋势洞察/技术品牌营销洞察报告》的 Python 类型技能。适用于车型项目、技术推广、技术品牌、行业趋势、市场客户、竞品分析、自身能力评估、战略机会识别、品牌营销建议等场景；当用户需要按标准模板输出季度或年度技术趋势洞察报告时使用。
---

# 技术发展趋势洞察报告 Skill

## 目标

根据用户输入的项目背景、技术方向、研究资料、访谈记录或结构化 JSON，生成符合平台标准模板的中文技术趋势洞察与技术品牌营销策略报告。

## 标准结构

本技能文件夹名固定为 `tech_trend_skill`，符合平台单个 Skill 目录规范：

```text
tech_trend_skill/
├── SKILL.md
├── references/
├── scripts/
├── templates/
└── assets/
```

## 使用流程

1. 读取用户输入，识别项目名称、行业领域、技术方向、报告周期、品牌/车型、已有事实和待补充信息。
2. 参考 `references/report-fields.md` 理解各字段填写口径。
3. 优先使用 `templates/technology_trend_insight_report.md` 的章节结构组织内容。
4. 如平台支持脚本执行，可调用 `scripts/generate_report.py`，用 JSON 输入生成 Markdown 报告。
5. 如缺少事实，使用“待补充”标记；不要编造具体数据来源、真实排名或未经提供的市场数字。
6. 最终输出应为中文 Markdown，可直接用于平台场景输出或人工二次编辑。

## Python 脚本调用

```bash
python scripts/generate_report.py --input input.json --output report.md
```

`input.json` 可只填写部分字段，脚本会按模板补齐空字段。

## 输出要求

- 必须包含“技术趋势洞察”“技术品牌营销洞察”“技术洞察及技术品牌营销策略建议思考”三大章节。
- 竞品分析必须使用表格，包含竞品、技术优势、技术劣势、差异化突破口。
- 策略建议必须能落到营销定位、宣发维度、渠道策略和落地节奏。
- 表达保持业务化、清晰、可执行，避免空泛口号。

## 资源说明

- `references/report-fields.md`：字段说明和判断口径。
- `templates/technology_trend_insight_report.md`：标准 Markdown 模板。
- `scripts/generate_report.py`：Python 生成脚本，使用标准库，无第三方依赖。
