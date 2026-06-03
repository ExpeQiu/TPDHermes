---
name: display_project_skill
description: 用于生成中文《IP技术展具制作立项书》的 Python 类型技能。适用于展具正式制作立项和预算审批，覆盖项目背景、展会概况、参展价值、展具规划策略、技术要求、布局规划、互动设计和预算明细。
---

# IP技术展具制作立项书 Skill

## 目标

根据用户输入的展会信息、参展价值、展具策略、技术展示要求、布局规划、互动设计和预算明细，生成符合平台标准模板的中文《IP技术展具制作立项书》。

## 标准结构

本技能文件夹名固定为 `display_project_skill`，符合平台单个 Skill 目录规范：

```text
display_project_skill/
├── SKILL.md
├── references/
├── scripts/
├── templates/
└── assets/
```

## 使用流程

1. 识别展会名称、主办方、定位、时间地点、参展价值和预期收获。
2. 参考 `references/report-fields.md` 理解各字段填写口径。
3. 按 `templates/display_project.md` 的结构输出 Markdown 立项书。
4. 如平台支持脚本执行，可调用 `scripts/generate_project.py`，用 JSON 输入生成 Markdown。
5. 信息不足时使用“待补充”标记；不要编造预算、展会信息、供应商或技术规格。
6. 输出应适合正式立项评审和预算审批。

## Python 脚本调用

```bash
python scripts/generate_project.py --input input.json --output display_project.md
```

## 输出要求

- 必须包含项目背景、展具规划策略、展具技术要求、展具预算四大章节。
- 展示亮点规划、展具技术亮点、预算明细必须使用表格。
- 技术要求要覆盖展示逻辑、展区风格、布局动线和互动设计。
- 预算需包含明细和总预算口径，未知金额用“待补充”。

## 资源说明

- `references/report-fields.md`：字段说明和判断口径。
- `templates/display_project.md`：标准 Markdown 模板。
- `scripts/generate_project.py`：Python 生成脚本，使用标准库，无第三方依赖。
