# IP技术展具使用说明书字段说明

## 一、展具概述

`basic_info` 包含：

- `display_id`：展具名称/编号。
- `display_type`：展具类型，例如标准展位、特装展台、移动展具。
- `core_function`：核心功能。
- `applicable_scenario`：适用场景。
- `accessories`：配套附件清单。

`technical_params` 包含：

- `size`：尺寸规格。
- `weight`：重量。
- `power_requirement`：电源要求。
- `setup_requirement`：搭建要求。

## 二、安全规范

`fire_safety`：阻燃等级、禁用材料、灭火器配置要求。
`height_limit`：最大高度、层高要求。
`load_limit`：最大承重、集中载荷限制。
`electrical_safety`：用电功率上限、接地要求、防水等级。

## 三、安装与拆卸

`transport_notes` 使用列表，每个对象包含：

- `stage`：环节。
- `requirement`：要求。
- `responsible_party`：责任方。

`assembly` 包含：

- `pre_check`：进场前检查。
- `floor_treatment`：地面处理。
- `main_setup_order`：主体搭建顺序。
- `electrical_wiring`：电气接线。
- `debug_test`：调试测试。
- `exhibit_display`：展品陈列。
- `acceptance`：完工验收。

`dismantle` 包含断电确认、展品拆卸顺序、包装存放、出场交接。

## 四、使用与维护

`usage_rules` 包含日开启流程、日使用规范、日关闭流程。

`fixture_methods` 使用列表，每个对象包含 `exhibit`、`fixture_method`、`tool_requirement`。

`storage` 包含温湿度要求、叠放规范、防护要求。

`care` 包含清洁频率、清洁方式、易损件检查。

`troubleshooting` 使用列表，每个对象包含 `fault_type`、`handling_method`、`emergency_contact`。
