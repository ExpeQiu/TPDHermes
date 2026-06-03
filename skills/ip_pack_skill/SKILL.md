---
name: ip_pack_skill
description: 用于生成中文《技术IP包装全案策划》的 Python 类型技能。适用于技术IP从0到1包装规划、全案目标、背景洞察、竞品IP分析、技术亮点场景、车型节奏互锁、IP打造计划、执行交付、预算估算和过程管控。
---

# 技术IP包装全案策划 Skill

## 目标

根据用户输入的技术 IP 名称、技术能力、品牌目标、竞品资料、车型节奏、传播资源和执行约束，生成符合平台标准模板的中文《技术IP包装全案策划》。

## 标准结构

本技能文件夹名固定为 `ip_pack_skill`，符合平台单个 Skill 目录规范：

```text
ip_pack_skill/
├── SKILL.md
├── references/
├── scripts/
├── templates/
└── assets/
```

## 使用流程

1. 识别技术 IP 名称、核心定位、目标成果、行业背景、用户洞察、竞品 IP、我方资源和车型节奏。
2. 参考 `references/report-fields.md` 理解各字段填写口径。
3. 按 `templates/ip_pack_plan.md` 的结构输出 Markdown 全案。
4. 如平台支持脚本执行，可调用 `scripts/generate_plan.py`，用 JSON 输入生成 Markdown。
5. 信息不足时使用“待补充”标记；不要编造未经提供的预算、认证、参数或竞品结论。
6. 输出应体现技术 IP 从定位、叙事、场景、节奏到交付管控的完整闭环。

## Python 脚本调用

```bash
python scripts/generate_plan.py --input input.json --output ip_pack_plan.md
```

`input.json` 可只填写部分字段，脚本会按模板补齐空字段。

## 输出要求

- 必须包含全案目标、背景洞察、技术IP亮点、项目策略、执行交付五大章节。
- 竞品技术IP分析、技术亮点场景、推进节奏互锁、项目分工、预算估算必须使用表格。
- 技术产品户型图可用文本结构表达核心层、支撑层、应用层。
- 执行交付要覆盖资源清单、预算估算和过程管控机制。

## 资源说明

- `references/report-fields.md`：字段说明和判断口径。
- `templates/ip_pack_plan.md`：标准 Markdown 模板。
- `scripts/generate_plan.py`：Python 生成脚本，使用标准库，无第三方依赖。
