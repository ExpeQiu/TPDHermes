---
name: tech_lockmap_skill
description: 用于生成中文《技术规划与技术品牌互锁地图》的 Python 类型技能。适用于技术规划、车型节奏、品牌策略、用户触点之间的协同对齐，输出技术节点、车型映射、品牌联动、触点规划和互锁核查清单。
---

# 技术规划与技术品牌互锁地图 Skill

## 目标

根据用户输入的技术规划、车型上市节奏、品牌传播动作和用户触点安排，生成符合平台标准模板的中文《技术规划与技术品牌互锁地图》。

## 标准结构

本技能文件夹名固定为 `tech_lockmap_skill`，符合平台单个 Skill 目录规范：

```text
tech_lockmap_skill/
├── SKILL.md
├── references/
├── scripts/
├── templates/
└── assets/
```

## 使用流程

1. 识别技术规划节点、技术里程碑、车型节奏、品牌动作、用户触点和协同责任。
2. 参考 `references/report-fields.md` 理解各字段填写口径。
3. 按 `templates/tech_lockmap.md` 的结构输出 Markdown 地图。
4. 如平台支持脚本执行，可调用 `scripts/generate_lockmap.py`，用 JSON 输入生成 Markdown。
5. 信息不足时使用“待补充”标记；不要编造具体上市时间、工程节点或组织责任。
6. 输出应突出“技术规划-车型节奏-品牌策略-用户触点”的闭环互锁关系。

## Python 脚本调用

```bash
python scripts/generate_lockmap.py --input input.json --output lockmap.md
```

`input.json` 可只填写部分字段，脚本会按模板补齐空字段。

## 输出要求

- 必须包含互锁关系总览、技术规划节点、车型节奏映射、品牌策略联动、用户触点规划、互锁核查清单。
- 技术规划节点、车型节奏映射、品牌策略联动、用户触点规划必须使用表格。
- 保留 Mermaid 互锁关系图，便于平台渲染流程关系。
- 核查清单应能用于跨部门协同复盘。

## 资源说明

- `references/report-fields.md`：字段说明和判断口径。
- `templates/tech_lockmap.md`：标准 Markdown 模板。
- `scripts/generate_lockmap.py`：Python 生成脚本，使用标准库，无第三方依赖。
