# IP技术认证策划方案字段说明

## 一、调研背景与目的

`background_value` 包含：

- `tech_ip_background`：技术 IP 背景。
- `certification_necessity`：行业认证必要性。
- `brand_endorsement`：品牌背书价值。
- `user_trust`：用户信任价值。
- `competitor_differentiation`：竞品差异化价值。

`certification_purpose` 包含：

- `core_purpose`：核心目的。
- `expected_result`：预期达成的认证结果。
- `application_scenarios`：后续应用场景。

## 二、项目介绍

`test_subjects` 使用列表，每个对象包含：

- `subject`：科目。
- `tech_selling_point`：对应技术卖点。
- `test_method`：测试方法。
- `evaluation_standard`：评价标准。

`test_rules` 使用列表，每个对象包含：

- `subject`：科目。
- `test_method`：测试方法。
- `value_requirement`：取值要求。
- `pass_standard`：合格标准。

`test_schedule` 包含测试时间、测试地点、场地要求、配合人员。

## 三、传播资源

`video_resources` 使用列表，每个对象包含 `video_type`、`content_requirement`、`production_cycle`、`owner`。

`communication_resources` 使用列表，每个对象包含 `channel`、`content_format`、`communication_time`、`owner`。

`communication_rights` 包含认证结果使用范围、媒体发布权益、官方传播权益。

## 四、整体报价

`quotation_items` 使用列表，每个对象包含：

- `category`：费用类别。
- `detail`：明细。
- `unit_price`：单价。
- `quantity`：数量。
- `total_price`：总价。
