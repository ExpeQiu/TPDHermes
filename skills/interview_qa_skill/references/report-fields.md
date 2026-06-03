# 领导采访QA字段说明

## 一、核心沟通底层逻辑

- `core_messages`：核心信息清单，建议 3-4 条。
- `answer_structure`：金字塔式回答结构说明。
- `attitude_principles`：态度原则，默认包含开放、自信、诚恳。

## 二、通用应答策略与话术模板

`answer_templates` 使用列表，每个对象包含：

- `type`：问题类型。
- `typical_question`：典型问题。
- `challenge`：核心挑战。
- `strategy`：应答策略。
- `talking_point`：参考话术。

默认可覆盖：

- 技术对比与竞品类。
- 技术落地与承诺类。
- 成本与商业化类。
- 缺陷与风险类。
- 战略与生态类。

## 三、Q&A预准备清单

`must_answer_questions` 使用列表，每个对象包含：

- `question`：问题。
- `answer_points`：建议回答要点。
- `forbidden_words`：禁忌词。

`sensitive_questions` 使用列表，每个对象包含：

- `question`：潜在敏感问题。
- `risk_level`：风险等级。
- `strategy`：推荐策略。

`personal_questions` 包含：

- `experience_background`：领导个人经历/背景相关。
- `personal_viewpoint`：领导观点相关。
