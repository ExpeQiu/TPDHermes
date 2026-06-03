# IP技术展具概念策划书字段说明

## 一、展具概述

`basic_info` 包含：

- `display_name`：展具名称。
- `display_type`：展具类型，例如静态模型、互动装置、透明结构件、数字屏展具。
- `venue`：展示场地，例如门店、展会、发布会、技术展厅。
- `duration`：展示时长。

- `concept_summary`：整体方案简介，描述设计概念和核心展示逻辑。
- `show_dimensions`：重点展示维度列表，建议 3 条。

`benchmark_cases` 使用列表，每个对象包含：

- `case`：参考案例。
- `highlight`：亮点。
- `learnable_point`：可借鉴点。

## 二、重点展示

`highlight_features`：亮点特征列表，建议 3 条。

- `principle_description`：展具原理说明，描述技术原理、展示机制或互动逻辑。

`detail_points` 使用列表，每个对象包含：

- `part`：细节部位。
- `show_point`：展示要点。
- `material_requirement`：物料要求。

- `diagram_note`：重要部分示意图，可描述关键结构或图示要求。

`maintenance` 包含：

- `maintenance_requirement`：保养要求。
- `transport_rule`：搬运规范。
- `storage_condition`：存储条件。

## 三、展具预算、周期

`budget_items` 使用列表，每个对象包含：

- `item`：费用项。
- `amount`：预算金额。
- `note`：说明。

`production_cycle` 包含：

- `concept_planning`：概念策划周期。
- `design_drawing`：设计出图周期。
- `prototype`：制作打样周期。
- `acceptance`：成品验收周期。
- `total_cycle`：总周期。
