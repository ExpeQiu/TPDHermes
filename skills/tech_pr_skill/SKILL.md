---
name: tech_pr_skill
description: 用于生成中文《IP技术/事件传播稿》的 Python 类型技能。适用于技术品牌发布、重大技术事件官方新闻稿，覆盖标题副标题、发布导语、技术亮点、问题与理念、关键技术特性、领导引言、战略意义、未来规划和媒体联络。
---

# IP技术/事件传播稿 Skill

## 目标

根据用户输入的公司信息、技术品牌/平台、发布事件、核心用户价值、关键技术、领导引言、战略意义和媒体联络信息，生成符合平台标准模板的中文官方新闻稿/传播稿。

## 标准结构

本技能文件夹名固定为 `tech_pr_skill`，符合平台单个 Skill 目录规范：

```text
tech_pr_skill/
├── SKILL.md
├── references/
├── scripts/
├── templates/
└── assets/
```

## 使用流程

1. 识别主标题、副标题、发布城市日期、公司名称、技术品牌/平台名称、所属领域和核心用户价值。
2. 参考 `references/report-fields.md` 理解各字段填写口径。
3. 按 `templates/tech_pr.md` 的结构输出 Markdown 传播稿。
4. 如平台支持脚本执行，可调用 `scripts/generate_pr.py`，用 JSON 输入生成 Markdown。
5. 信息不足时使用“待补充”标记；不要编造性能数据、领导姓名、车型规划、媒体联络或公司信息。
6. 输出应适合官方新闻稿、媒体通稿和技术事件传播初稿。

## Python 脚本调用

```bash
python scripts/generate_pr.py --input input.json --output tech_pr.md
```

## 输出要求

- 必须包含主标题、副标题、发布导语、技术亮点、技术理念、关键技术特性、领导言论、战略意义、公司简介和媒体联络。
- 语言应正式、清晰、面向媒体，避免内部黑话。
- 数据、百分比、车型数量、上市规划等必须来自用户输入；缺失时保留“待补充”。
- 领导引言须稳健，不做无法兑现的绝对承诺。

## 资源说明

- `references/report-fields.md`：字段说明和判断口径。
- `templates/tech_pr.md`：标准 Markdown 模板。
- `scripts/generate_pr.py`：Python 生成脚本，使用标准库，无第三方依赖。
