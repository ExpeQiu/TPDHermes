---
name: display_guide_skill
description: 用于生成中文《IP技术展具使用说明书》的 Python 类型技能。适用于展具交付后的使用规范、操作指南、安全须知、安装拆卸、运输搬运、日常维护、存储护理和故障处理文档生成。
---

# IP技术展具使用说明书 Skill

## 目标

根据用户输入的展具信息、技术参数、安全规范、安装拆卸流程、使用维护要求和故障处理口径，生成符合平台标准模板的中文《IP技术展具使用说明书》。

## 标准结构

本技能文件夹名固定为 `display_guide_skill`，符合平台单个 Skill 目录规范：

```text
display_guide_skill/
├── SKILL.md
├── references/
├── scripts/
├── templates/
└── assets/
```

## 使用流程

1. 识别展具名称编号、类型、核心功能、适用场景、附件清单和技术参数。
2. 参考 `references/report-fields.md` 理解各字段填写口径。
3. 按 `templates/display_guide.md` 的结构输出 Markdown 使用说明书。
4. 如平台支持脚本执行，可调用 `scripts/generate_guide.py`，用 JSON 输入生成 Markdown。
5. 信息不足时使用“待补充”标记；不要编造安全认证、电气参数、承重数据或联系人信息。
6. 输出应便于交付后运营、门店、搭建方和维护人员直接执行。

## Python 脚本调用

```bash
python scripts/generate_guide.py --input input.json --output display_guide.md
```

## 输出要求

- 必须包含展具概述、安全规范、安装与拆卸、使用与维护四大章节。
- 运输注意事项、展品固定方式、故障处理必须使用表格。
- 安全规范需覆盖防火、限高、承重和电气安全。
- 安装拆卸流程需分步骤，便于现场执行和验收。

## 资源说明

- `references/report-fields.md`：字段说明和判断口径。
- `templates/display_guide.md`：标准 Markdown 模板。
- `scripts/generate_guide.py`：Python 生成脚本，使用标准库，无第三方依赖。
