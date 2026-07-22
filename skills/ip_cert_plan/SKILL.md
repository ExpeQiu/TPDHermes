---
name: ip_cert_plan
description: 生成中文《IP技术认证策划方案》（认证科目、规则排期、传播权益与报价）。当用户需要第三方认证立项、权威认证策划、认证传播权益时使用。
when: 技术认证 / 第三方认证 / 认证立项 / 认证传播权益
---

## 何时调用

用户提到或隐含需要：技术认证 / 第三方认证 / 认证立项 / 认证传播权益 时，优先调用本技能。

触发词：技术认证、第三方认证、认证策划、认证立项、权威认证。

# IP技术认证策划方案 Skill

## 目标

根据用户输入的技术 IP 背景、认证目的、测试科目、测试规则、认证资源、传播权益和报价预算，生成符合平台标准模板的中文《IP技术认证策划方案》。

## 标准结构

本技能文件夹名固定为 `ip_cert_plan`，符合平台单个 Skill 目录规范：

```text
ip_cert_plan/
├── SKILL.md
├── references/
├── scripts/
├── templates/
└── assets/
```

## 使用流程

1. 识别技术 IP 背景、行业认证必要性、认证价值、核心目的和后续应用场景。
2. 参考 `references/report-fields.md` 理解各字段填写口径。
3. 按 `templates/ip_cert_plan.md` 的结构输出 Markdown 策划方案。
4. 如平台支持脚本执行，可调用 `scripts/generate_plan.py`，用 JSON 输入生成 Markdown。
5. 信息不足时使用“待补充”标记；不要编造认证机构、测试结果、报价或合格标准。
6. 输出应适合第三方认证项目立项、供应商沟通和传播资源规划。

## Python 脚本调用

```bash
python scripts/generate_plan.py --input input.json --output ip_cert_plan.md
```

## 输出要求

- 必须包含调研背景与目的、项目介绍、传播资源、整体报价四大章节。
- 测试科目、测试规则、视频资源、传播资源和报价必须使用表格。
- 认证价值需覆盖品牌背书、用户信任、竞品差异化。
- 报价未知时使用“待补充”，不得虚构金额。

## 资源说明

- `references/report-fields.md`：字段说明和判断口径。
- `templates/ip_cert_plan.md`：标准 Markdown 模板。
- `scripts/generate_plan.py`：Python 生成脚本，使用标准库，无第三方依赖。
