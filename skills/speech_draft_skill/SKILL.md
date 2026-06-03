---
name: speech_draft_skill
description: 用于生成中文《领导讲稿》的 Python 类型技能。适用于发布会、技术日、重大活动领导开场演讲稿，覆盖开篇问候、行业洞察、发布定调、技术叙事、用户价值、生态开放、号召邀请和致谢。
---

# 领导讲稿 Skill

## 目标

根据用户输入的活动场景、技术品牌、核心价值主张、行业洞察、用户痛点、技术支柱、场景价值和结尾号召，生成符合平台标准模板的中文领导讲稿。

## 标准结构

本技能文件夹名固定为 `speech_draft_skill`，符合平台单个 Skill 目录规范：

```text
speech_draft_skill/
├── SKILL.md
├── references/
├── scripts/
├── templates/
└── assets/
```

## 使用流程

1. 识别活动场合、领导身份、核心技术名称、价值主张、听众对象和演讲时长。
2. 参考 `references/report-fields.md` 理解各字段填写口径。
3. 按 `templates/speech_draft.md` 的结构输出 Markdown 讲稿。
4. 如平台支持脚本执行，可调用 `scripts/generate_speech.py`，用 JSON 输入生成 Markdown。
5. 信息不足时使用“待补充”标记；不要编造技术数据、合作伙伴或发布承诺。
6. 输出应适合发布会、技术日等重大场合，可进一步润色为口语化演讲稿。

## Python 脚本调用

```bash
python scripts/generate_speech.py --input input.json --output speech_draft.md
```

## 输出要求

- 必须包含开篇、主体技术叙事、结尾三大章节。
- 技术支柱建议 3 条；用户场景价值必须使用表格。
- 语气应正式、坚定、面向公众，避免内部黑话。
- 涉及数据或承诺时必须有来源或使用“待补充”。

## 资源说明

- `references/report-fields.md`：字段说明和判断口径。
- `templates/speech_draft.md`：标准 Markdown 模板。
- `scripts/generate_speech.py`：Python 生成脚本，使用标准库，无第三方依赖。
