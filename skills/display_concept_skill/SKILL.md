---
name: display_concept_skill
description: 生成中文《IP技术展具概念策划书》（展示维度、行业对标、原理亮点、预算周期）。当用户需要展具概念、展台概念策划、技术展具方案时使用。
when: 展具概念 / 展台概念 / 技术展具策划
---

## 何时调用

用户提到或隐含需要：展具概念 / 展台概念 / 技术展具策划 时，优先调用本技能。

触发词：展具概念、展台概念、技术展具、展具策划。

# IP技术展具概念策划书 Skill

## 目标

根据用户输入的技术 IP、展示目标、场地、展示方式、参考案例、预算和周期约束，生成符合平台标准模板的中文《IP技术展具概念策划书》。

## 标准结构

本技能文件夹名固定为 `display_concept_skill`，符合平台单个 Skill 目录规范：

```text
display_concept_skill/
├── SKILL.md
├── references/
├── scripts/
├── templates/
└── assets/
```

## 使用流程

1. 识别展具名称、类型、展示场地、展示时长、整体设计概念和核心展示逻辑。
2. 参考 `references/report-fields.md` 理解各字段填写口径。
3. 按 `templates/display_concept.md` 的结构输出 Markdown 策划书。
4. 如平台支持脚本执行，可调用 `scripts/generate_concept.py`，用 JSON 输入生成 Markdown。
5. 信息不足时使用“待补充”标记；不要编造预算、材质、供应商或制作周期。
6. 输出应适合概念阶段评审和后续立项深化。

## Python 脚本调用

```bash
python scripts/generate_concept.py --input input.json --output display_concept.md
```

## 输出要求

- 必须包含展具概述、重点展示、展具预算与周期三大章节。
- 行业对标、展具尖点细节、预算估算必须使用表格。
- 重点展示维度和亮点特征要能体现技术 IP 的用户可感知价值。
- 保养、搬运、存储要求要便于后续制作与运营承接。

## 资源说明

- `references/report-fields.md`：字段说明和判断口径。
- `templates/display_concept.md`：标准 Markdown 模板。
- `scripts/generate_concept.py`：Python 生成脚本，使用标准库，无第三方依赖。
