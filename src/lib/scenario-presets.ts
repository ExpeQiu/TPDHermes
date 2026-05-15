/**
 * 内置种子数据：仅用于 `/create` 冷启动与引导卡片。
 * 对话创作、场景输出等执行链路以服务端 `ScenarioProfile` / GET /scenarios/{id} 为准。
 */

export type Scenario = {
  id: string;
  title: string;
  summary: string;
  goal: string;
  recommendedTemplate: string;
  recommendedKnowledgeMode: string;
  recommendedSections: string[];
  systemContext: string;
};

export const SCENARIOS: Scenario[] = [
  {
    id: "tech-doc",
    title: "技术方案说明",
    summary: "面向客户或合作方输出结构化技术说明、方案综述与价值阐述。",
    goal: "输出一版可用于外部沟通的技术方案说明。",
    recommendedTemplate: "方案说明",
    recommendedKnowledgeMode: "优先使用项目知识和指定集合",
    recommendedSections: ["背景", "目标", "方案设计", "优势", "风险"],
    systemContext: `你是一位资深技术写作专家，擅长：
- 撰写清晰、准确、专业的技术文档
- 将复杂的技术概念用通俗易懂的语言解释
- 按照行业标准组织文档结构
- 提供完整的最佳实践说明

输出风格：专业、简洁、结构化，适合开发者和技术人员阅读。`,
  },
  {
    id: "data-report",
    title: "分析汇报",
    summary: "生成结论前置、洞察清晰、适合汇报评审的分析报告。",
    goal: "输出一版适合管理层或项目评审的分析汇报。",
    recommendedTemplate: "分析报告",
    recommendedKnowledgeMode: "优先使用知识集合并保留事实来源",
    recommendedSections: ["执行摘要", "现状分析", "核心发现", "行动建议"],
    systemContext: `你是一位专业的数据分析师，擅长：
- 从数据中发现业务洞察和机会
- 将数据转化为可执行的策略建议
- 构建清晰的叙事逻辑，结论先行
- 使用图表描述和替代方案（如有数据）

输出风格：数据驱动、逻辑严谨、结论前置，建议具体可落地。`,
  },
  {
    id: "prd",
    title: "PRD 草案",
    summary: "快速整理业务背景、用户故事、范围边界与验收要求。",
    goal: "输出一版适合评审讨论的 PRD 初稿。",
    recommendedTemplate: "PRD",
    recommendedKnowledgeMode: "以项目背景为主，知识库作为补充",
    recommendedSections: ["产品概述", "目标用户", "需求范围", "功能需求", "验收标准"],
    systemContext: `你是一位资深产品经理，擅长：
- 撰写结构完整、逻辑清晰的产品需求文档
- 拆解用户故事，定义功能范围和验收标准
- 平衡用户体验、技术可行性和业务价值
- 识别边界情况和依赖关系

输出风格：专业、条理清晰、用词精准，适合跨团队协作和评审。`,
  },
  {
    id: "marketing",
    title: "营销传播素材",
    summary: "提炼卖点、场景价值和传播话术，适合市场传播与品牌内容。",
    goal: "输出一版可直接进入传播打磨的营销素材。",
    recommendedTemplate: "营销文案",
    recommendedKnowledgeMode: "优先使用产品知识和标准术语口径",
    recommendedSections: ["核心主张", "卖点提炼", "传播话术", "行动号召"],
    systemContext: `你是一位技术品牌营销专家，擅长：
- 提炼技术亮点并转化为受众语言
- 撰写有传播力的标题、导语和核心文案
- 适配不同平台和场景
- 将技术叙事与品牌价值有机结合

输出风格：精准、有吸引力、具备传播势能，适合市场推广和品牌传播场景。`,
  },
  {
    id: "debug",
    title: "故障复盘报告",
    summary: "整理问题时间线、影响范围、根因与改进动作，形成复盘文档。",
    goal: "输出一版完整的故障排查与复盘报告。",
    recommendedTemplate: "复盘报告",
    recommendedKnowledgeMode: "优先结合项目上下文和历史事实记录",
    recommendedSections: ["问题概述", "时间线", "根因分析", "影响评估", "改进措施"],
    systemContext: `你是一位经验丰富的 SRE/运维工程师，擅长：
- 系统性排查线上故障，快速定位根因
- 撰写结构化的故障报告
- 输出可落地的改进措施和预防方案
- 将技术细节翻译为业务影响说明

输出风格：客观、详实、以解决问题为导向，适合事后复盘和团队分享。`,
  },
  {
    id: "kb-qa",
    title: "知识问答提炼",
    summary: "基于资料集合做摘要提炼、问答对整理和知识点沉淀。",
    goal: "输出一版面向复用的知识问答与摘要。",
    recommendedTemplate: "知识摘要",
    recommendedKnowledgeMode: "必须携带知识集合并要求引用事实",
    recommendedSections: ["核心摘要", "关键知识点", "问答对", "待补充信息"],
    systemContext: `你是一位专业的知识管理专家，擅长：
- 从长文档中快速提取关键信息和知识点
- 生成精准的问答对，用于知识库建设
- 将分散信息归纳为结构化的知识手册
- 用通俗语言解释专业概念

输出风格：简洁、准确、易于理解，适合知识沉淀和团队培训。`,
  },
];

export const LOCAL_SCENARIO_IDS = new Set(SCENARIOS.map((s) => s.id));
