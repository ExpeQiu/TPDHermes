---
name: interview_qa_skill
description: 生成中文《领导采访QA》（金字塔答法、桥梁法、必答题与敏感题）。当用户需要采访QA、媒体问答、发布会问答、敏感问题应对时使用。
when: 采访QA / 媒体问答 / 发布会问答 / 敏感题应对
---

## 何时调用

用户提到或隐含需要：采访QA / 媒体问答 / 发布会问答 / 敏感题应对 时，优先调用本技能。

触发词：采访QA、媒体问答、发布会问答、敏感问题、领导采访。

# 领导采访QA Skill

## 目标

根据用户输入的发布会核心信息、技术品牌主张、采访场景、典型问题、敏感问题和领导个人化信息，生成符合平台标准模板的中文《领导采访QA》。

## 标准结构

本技能文件夹名固定为 `interview_qa_skill`，符合平台单个 Skill 目录规范：

```text
interview_qa_skill/
├── SKILL.md
├── references/
├── scripts/
├── templates/
└── assets/
```

## 使用流程

1. 识别发布会或专访的 3-4 个核心信息点、品牌立场和敏感问题边界。
2. 参考 `references/report-fields.md` 理解各字段填写口径。
3. 按 `templates/interview_qa.md` 的结构输出 Markdown QA 文档。
4. 如平台支持脚本执行，可调用 `scripts/generate_qa.py`，用 JSON 输入生成 Markdown。
5. 信息不足时使用“待补充”标记；不要编造数据、承诺、竞品事实或未授权表述。
6. 输出应适合领导访前准备、媒体问答训练和敏感问题统一口径。

## Python 脚本调用

```bash
python scripts/generate_qa.py --input input.json --output interview_qa.md
```

## 输出要求

- 必须包含核心沟通底层逻辑、通用应答策略与话术模板、Q&A预准备清单三大章节。
- 必答题和敏感题必须使用表格。
- 应答话术应遵循“感谢/认可 + 核心立场 + 具体阐述 + 回归愿景”。
- 涉及竞品、法规、时间表、缺陷风险时必须保持稳健和审慎。

## 资源说明

- `references/report-fields.md`：字段说明和判断口径。
- `templates/interview_qa.md`：标准 Markdown 模板。
- `scripts/generate_qa.py`：Python 生成脚本，使用标准库，无第三方依赖。
