# 技术品牌调研计划字段说明

## 一、调研背景与目的

`background` 包含：

- `industry_trend`：行业趋势背景。
- `strategy_need`：企业战略需求。
- `research_trigger`：启动调研的动因。

`purpose` 包含：

- `core_questions`：核心问题列表，建议 3 条。
- `quantitative_goal`：量化目标。
- `strategy_output_expectation`：策略输出期望。

## 二、调研方法与范围

`research_methods` 使用列表，每个对象包含：

- `method`：方法，例如线下拦截、线上问卷、电话调研、入户深访、随车深访、专家访谈、社交舆情。
- `scenario`：适用场景。
- `sample_size`：样本量。
- `cycle`：执行周期。

`research_contents`：研究内容列表。

`sample_plan` 包含：

- `target_users`：目标人群。
- `segments`：覆盖细分市场。

`region_coverage` 使用列表，每个对象包含 `region`、`city`、`sample_size`。

`respondent_requirements` 包含：

- `entry_criteria`：准入条件。
- `exclusion_criteria`：排除条件。
- `quota_requirements`：配额要求。

`supplier_requirements` 包含资质要求和团队要求。

`execution_plan` 使用列表，每个对象包含 `stage`、`time`、`milestone`。

## 三、预算

`budget_scale` 包含：

- `total_range`：总预算范围。
- `budget_ceiling`：预算上限。

`budget_allocation` 使用列表，每个对象包含：

- `item`：费用项。
- `ratio`：占比。
- `note`：说明。
