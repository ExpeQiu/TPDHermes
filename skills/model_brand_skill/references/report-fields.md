# 技术品牌赋能车型策略方案字段说明

## 基础信息

- `title`：报告标题，默认使用“技术推广-车型项目管理流程-技术品牌赋能车型策略方案”。
- `model_name`：车型名称。
- `model_positioning`：车型定位，例如家庭旗舰 SUV、智能纯电轿车、年轻化入门车型等。
- `product_power_mix`：产品力组合，可包含设计、空间、智能、性能、安全、补能、舒适等。

## 一、车型技术品牌识别

### 技术品牌 IP 来源

- `tech_ip_definition`：技术品牌 IP 的整体定义，说明品牌要沉淀的技术资产。
- `brand_value_rule`：品牌价值最大化准则，例如用户可感知、车型可承接、传播可持续、证据可验证。

### 车型基本信息

- `model_name`：车型名称。
- `model_positioning`：车型定位。
- `product_power_mix`：产品力组合说明。

### 车型语境下的技术 IP 侧重点

`tech_ip_focus` 使用列表，每个对象包含：

- `ip`：技术 IP 名称。
- `empower_direction`：赋能方向，例如安全、智能、舒适、性能、生态。
- `focus_note`：在该车型语境下的表达侧重点。

### 技术 IP 联动赋能方向

- `overall_empower_direction`：整体赋能方向说明。
- `ip_relationship`：IP 间相互关系，例如主从、并列、底层支撑、场景协同。

## 二、车型技术品牌核心策略

- `core_concept`：核心概念阐述，说明车型技术品牌主张。
- `ip_hierarchy`：技术品牌 IP 层级结构。
- `synergy_logic`：协同赋能逻辑，说明各 IP 如何共同支撑车型价值。

### 技术支撑信息

`supporting_info` 使用列表，每个对象包含：

- `dimension`：支撑维度，例如安全、智能、舒适、性能、可靠。
- `info`：具体信息。
- `evidence`：佐证数据或证据；没有数据时填“待补充”。

### 技术侧支撑车型亮点整体指导

- `highlights`：车型技术亮点列表，建议 3 条，分别对应不同用户收益。

## 三、车型侧技术品牌重点问题回应

### 配置倒挂问题

- `config_inversion_issue`：问题描述。
- `config_inversion_response`：回应策略。

### 单独命名问题

- `naming_issue`：问题描述。
- `naming_response`：回应策略。

### 其他敏感问题

`sensitive_issues` 使用列表，每个对象包含：

- `issue`：问题。
- `risk_level`：风险等级，例如高、中、低。
- `response`：回应策略。
