# 技术IP包装货架文档字段说明

## 一、用户需求

`target_user` 包含：

- `user_group`：用户群体。
- `use_scenario`：使用场景。
- `core_appeal`：核心诉求。

`need_matches` 使用列表，每个对象包含：

- `user_need`：用户需求。
- `matched_tech`：契合的技术点。
- `differentiation`：差异化优势。

## 二、行业扫描

`industry_scan` 包含：

- `stage`：所处阶段，例如导入期、成长期、成熟期。
- `influence_assessment`：行业影响力评估。

`comparison` 使用列表，每个对象包含：

- `dimension`：对比维度。
- `ours`：我方表现。
- `competitor_a`：竞品 A。
- `competitor_b`：竞品 B。
- `competitor_c`：竞品 C。

## 三、技术包装信息屋

- `slogan`：一句话核心主张，建议 8-15 字。

`vision` 包含：

- `technology_vision`：技术愿景。
- `brand_vision`：品牌愿景。
- `user_vision`：用户愿景。

`positioning` 包含：

- `description`：定位描述。
- `support_points`：定位支撑点。

`user_value` 包含：

- `functional_value`：功能价值。
- `emotional_value`：情感价值。
- `symbolic_value`：象征价值。

`tech_outline` 使用列表，每个对象包含：

- `name`：核心技术名称。
- `principle`：技术原理。
- `metric`：性能指标。

`model_matches` 使用列表，每个对象包含：

- `model`：车型。
- `status`：搭载状态。
- `scenario`：匹配场景。

## 四、技术亮点延展

`better_points` 使用列表，每个对象包含：

- `tech_point`：技术点。
- `advantage`：我方优势。
- `metric`：量化指标。
- `evidence`：佐证材料。

`unique_points` 使用列表，每个对象包含：

- `tech_point`：技术点。
- `exclusive_advantage`：独占优势。
- `barrier`：壁垒说明。
- `launch_time`：上市时间。

`scenario_info` 使用列表，每个对象包含：

- `scenario`：场景。
- `pain_point`：用户痛点。
- `solution`：技术如何解决。
- `promotion_angle`：推广角度。
