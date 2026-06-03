---
name: model_brand_skill
description: 用于生成中文《技术品牌赋能车型策略方案》的 Python 类型技能。适用于技术品牌与具体车型绑定、车型技术IP识别、技术品牌核心策略、车型亮点支撑、配置倒挂回应、单独命名回应和敏感问题策略制定等场景。
---

# 技术品牌赋能车型策略方案 Skill

## 目标

根据用户输入的车型信息、技术品牌 IP、产品力组合、技术支撑资料和潜在传播风险，生成符合平台标准模板的中文《技术品牌赋能车型策略方案》。

## 标准结构

本技能文件夹名固定为 `model_brand_skill`，符合平台单个 Skill 目录规范：

```text
model_brand_skill/
├── SKILL.md
├── references/
├── scripts/
├── templates/
└── assets/
```

## 使用流程

1. 识别车型名称、车型定位、产品力组合、技术品牌 IP、目标人群和传播语境。
2. 参考 `references/report-fields.md` 理解各字段填写口径。
3. 按 `templates/model_brand_strategy.md` 的章节结构输出 Markdown 方案。
4. 如平台支持脚本执行，可调用 `scripts/generate_strategy.py`，用 JSON 输入生成 Markdown。
5. 信息不足时使用“待补充”标记，不编造未经提供的参数、销量、排名或认证信息。
6. 输出应聚焦车型与技术品牌之间的绑定逻辑、赋能方向、支撑证据和风险回应。

## Python 脚本调用

```bash
python scripts/generate_strategy.py --input input.json --output strategy.md
```

`input.json` 可只填写部分字段，脚本会按模板补齐空字段。

## 输出要求

- 必须包含“车型技术品牌识别”“车型技术品牌核心策略”“车型侧技术品牌重点问题回应”三大章节。
- 技术 IP 侧重点、技术支撑信息、敏感问题回应必须使用表格。
- 核心策略要说明技术 IP 的层级、协同关系和对车型亮点的支撑。
- 风险回应要清晰区分问题描述、风险等级和回应策略。

## 资源说明

- `references/report-fields.md`：字段说明和判断口径。
- `templates/model_brand_strategy.md`：标准 Markdown 模板。
- `scripts/generate_strategy.py`：Python 生成脚本，使用标准库，无第三方依赖。
