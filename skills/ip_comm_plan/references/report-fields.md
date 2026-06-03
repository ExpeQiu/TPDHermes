# 技术IP传播策划方案字段说明

## 一、项目概述

`project_background` 包含：

- `industry_trend`：行业趋势。
- `market_competition`：市场竞争格局。
- `start_reason`：启动原因。

`core_goal` 包含：

- `one_sentence`：一句话概括传播终极目的。
- `description`：目标描述。
- `smart_check`：SMART 核查列表或说明。

- `key_message`：本次传播最希望目标用户记住的一句话。

`budget_cycle` 包含：

- `total_budget_range`：总预算范围。
- `core_cycle`：核心传播周期。

## 二、传播策略及目标

`communication_goals` 使用列表，每个对象包含 `dimension`、`metric`、`note`。

`strategy` 包含：

- `overall_path`：总体路径。
- `message_line`：信息主线。

`audience_segments` 使用列表，每个对象包含 `audience`、`core_need`、`channel`、`message_angle`。

`content_plan` 使用列表，每个对象包含 `content_type`、`core_content`、`target_audience`、`channel`。

`channel_plan` 使用列表，每个对象包含 `channel`、`content_format`、`matched_content`、`execution_point`。

## 三、传播节奏/ROADMAP

`roadmap` 使用列表，每个对象包含 `stage`、`time`、`stage_goal`、`core_action`。

`stage_details` 包含：

- `warmup`：预热期安排。
- `burst`：爆发期安排。
- `sustain`：延续期安排。

每个阶段包含 `period`、`goal`、`format`、`key_content`。

## 四、传播预算和效果评估

`budget_items` 使用列表，每个对象包含 `category`、`detail`、`amount`、`ratio`。

`evaluation_metrics` 使用列表，每个对象包含 `metric`、`expected_value`、`measurement_method`。
