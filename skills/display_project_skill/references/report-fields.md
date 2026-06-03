# IP技术展具制作立项书字段说明

## 一、项目背景

`exhibition` 包含：

- `name`：展会名称。
- `organizer`：主办方。
- `positioning`：展会定位。
- `time`：展会时间。
- `location`：展会地点。

`value` 包含：

- `strategic_value`：战略价值。
- `brand_value`：品牌价值。
- `business_value`：业务价值。

`expected_gains` 包含：

- `short_term`：短期收获。
- `mid_term`：中期收获。
- `long_term`：长期收获。

## 二、展具规划策略

`strategy_alignment` 包含：

- `group_strategy`：集团战略方向。
- `tech_integration_strategy`：技术尖点融入策略。

`display_positioning` 包含：

- `display_goal`：展示目标。
- `target_audience`：目标受众。
- `differentiation`：差异化定位。

`highlight_plan` 使用列表，每个对象包含 `highlight`、`technology_support`、`display_method`。

## 三、展具技术要求

- `display_logic`：整体技术展示逻辑结构。

`zone_style` 包含：

- `area`：展区面积。
- `style_tone`：风格调性。
- `color_rule`：色彩规范。

`layout` 包含：

- `entrance`：入口。
- `core_area`：核心区。
- `interactive_area`：互动区。
- `exit`：出口。

`technical_highlights` 使用列表，每个对象包含 `highlight`、`description`、`material_spec`。

`interaction_design` 包含：

- `interaction_form`：互动形式。
- `interaction_flow`：互动流程。
- `technical_support`：技术保障。

## 四、展具预算

`budget_details` 使用列表，每个对象包含：

- `category`：类别。
- `item`：项目。
- `unit_price`：单价。
- `quantity`：数量。
- `total_price`：总价。

`total_budget` 包含：

- `design_fee`：设计费。
- `production_fee`：制作费。
- `transport_fee`：运输费。
- `maintenance_fee`：维护费。
- `total`：合计。
