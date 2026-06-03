# 技术推广活动策划方案字段说明

## 一、展会信息

`exhibition_info` 包含主办方、展会简介、展会价值、主题、主题内涵、展会时间、展会地址、展位面积。

`exhibition_values` 可列出技术展示、行业交流、销售平台、品牌传播等价值。

## 二、策略展开

`strategy` 包含：

- `enterprise_alignment`：企业战略对齐。
- `tech_display_value`：技术展示价值。
- `business_conversion_value`：商业转化价值。
- `industry_trend_forecast`：行业趋势预判。
- `competitor_dynamics`：竞品参展动态。
- `hot_topic_forecast`：热点话题预测。

## 三、参展目标

`strategic_goals` 包含品牌形象目标、技术传播目标、业务转化目标。

`quantitative_goals` 使用列表，每个对象包含 `metric`、`target_value`、`measurement_method`。

## 四、传播目标及规划

`communication_plan` 包含传播覆盖目标、互动量目标、话题目标、传播合规要求、竞品对比规则、敏感话题处理。

## 五、展台信息

`booth_info` 包含展台位置、面积、设计主题。

`booth_zones` 使用列表，每个对象包含 `zone`、`function`、`core_content`。

`tech_highlights` 为技术展示亮点列表。

## 六、展会时间节点

`timeline` 使用列表，每个对象包含 `time_node`、`content`、`owner`、`completion_standard`。

## 七、技术代言人安排

`spokespersons` 使用列表，每个对象包含 `person`、`position`、`responsible_part`、`speech_content`。

`schedule` 包含媒体日、公众日安排。

## 八、任务分工

`task_assignments` 使用列表，每个对象包含 `department`、`responsibility`、`core_task`、`deliverable`。

`key_collaboration_nodes` 包含筹备启动会、物料审核节点、展前彩排、现场执行。
