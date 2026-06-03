---
name: ip_cert_plan
description: 用于生成中文《IP技术认证策划方案》的 Python 类型技能。适用于技术IP第三方权威认证项目立项，覆盖认证背景价值、认证目的、测试科目、测试规则、测试时间安排、传播资源、传播权益和整体报价。
---

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
