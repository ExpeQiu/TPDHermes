---
name: brand_name_skill
description: 用于生成中文《技术品牌策略/命名报告》的 Python 类型技能。适用于技术品牌策略制定、命名方向决策、行业洞察、品牌包装亮点、核心信息屋、策略目标、传播节奏和车型发布节点绑定。
---

# 技术品牌策略/命名报告 Skill

## 目标

根据用户输入的行业洞察、技术亮点、市场占位、策略目标、核心信息、候选命名方向和传播节奏，生成符合平台标准模板的中文《技术品牌策略/命名报告》。

## 标准结构

本技能文件夹名固定为 `brand_name_skill`，符合平台单个 Skill 目录规范：

```text
brand_name_skill/
├── SKILL.md
├── references/
├── scripts/
├── templates/
└── assets/
```

## 使用流程

1. 识别行业趋势、竞争格局、用户认知、技术包装亮点、市场占位和差异化机会。
2. 参考 `references/report-fields.md` 理解各字段填写口径。
3. 按 `templates/brand_name_report.md` 的结构输出 Markdown 报告。
4. 如平台支持脚本执行，可调用 `scripts/generate_report.py`，用 JSON 输入生成 Markdown。
5. 信息不足时使用“待补充”标记；不要编造市场数据、法律检索结论或命名可注册性。
6. 输出应支持技术品牌策略制定和命名方向决策。

## Python 脚本调用

```bash
python scripts/generate_report.py --input input.json --output brand_name_report.md
```

## 输出要求

- 必须包含技术品牌洞察、技术品牌策略、技术品牌核心信息、技术品牌核心节奏四大章节。
- 策略目标、关键阶段划分、车型发布节点绑定必须使用表格。
- 核心信息屋应包含顶层信息和 3 条支撑信息。
- 若涉及命名建议，需说明命名逻辑、传播适配和风险提示。

## 资源说明

- `references/report-fields.md`：字段说明和判断口径。
- `templates/brand_name_report.md`：标准 Markdown 模板。
- `scripts/generate_report.py`：Python 生成脚本，使用标准库，无第三方依赖。
