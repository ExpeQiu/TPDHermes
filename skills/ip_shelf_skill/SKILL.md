---
name: ip_shelf_skill
description: 生成中文《技术IP包装货架文档》（信息屋、Slogan/愿景/定位、亮点与车型匹配）。当用户需要IP货架、标准化信息包、技术包装沉淀时使用。
when: IP货架 / 标准化信息包 / 技术包装沉淀 / 信息屋
---

## 何时调用

用户提到或隐含需要：IP货架 / 标准化信息包 / 技术包装沉淀 / 信息屋 时，优先调用本技能。

触发词：IP货架、包装货架、信息包、技术包装沉淀、信息屋。

# 技术IP包装货架文档 Skill

## 目标

根据用户输入的技术 IP 信息、用户需求、行业对比、技术定位、核心技术、车型匹配和场景亮点，生成符合平台标准模板的中文《技术IP包装货架文档》，便于各团队复用。

## 标准结构

本技能文件夹名固定为 `ip_shelf_skill`，符合平台单个 Skill 目录规范：

```text
ip_shelf_skill/
├── SKILL.md
├── references/
├── scripts/
├── templates/
└── assets/
```

## 使用流程

1. 识别技术 IP 名称、目标用户、使用场景、用户诉求、行业地位、竞品对比和车型搭载情况。
2. 参考 `references/report-fields.md` 理解各字段填写口径。
3. 按 `templates/ip_shelf_doc.md` 的结构输出 Markdown 货架文档。
4. 如平台支持脚本执行，可调用 `scripts/generate_shelf.py`，用 JSON 输入生成 Markdown。
5. 信息不足时使用“待补充”标记；不要编造量化指标、独占优势、上市时间或竞品事实。
6. 输出应作为标准化信息包，便于品牌、产品、销售、门店、传播团队复用。

## Python 脚本调用

```bash
python scripts/generate_shelf.py --input input.json --output ip_shelf_doc.md
```

`input.json` 可只填写部分字段，脚本会按模板补齐空字段。

## 输出要求

- 必须包含用户需求、行业扫描、技术包装信息屋、技术亮点延展四大章节。
- 用户需求契合点、横向对比、车型匹配、技术尖点、技术场景必须使用表格。
- Slogan 建议控制在 8-15 字，表达核心主张。
- 技术大纲应至少覆盖核心技术、技术原理和性能指标。

## 资源说明

- `references/report-fields.md`：字段说明和判断口径。
- `templates/ip_shelf_doc.md`：标准 Markdown 模板。
- `scripts/generate_shelf.py`：Python 生成脚本，使用标准库，无第三方依赖。
