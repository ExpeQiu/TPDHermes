/**
 * 内置种子数据：仅用于 `/create` 冷启动与引导卡片。
 * 对话创作、场景输出等执行链路以服务端 `ScenarioProfile` / GET /scenarios/{id} 为准。
 * 与 backend/data/builtin_scenarios.py v2.0.0 对齐（id 稳定，语义按技能域刷新）。
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
  /** 场景合同主技能（工坊 allowed[0]） */
  primarySkill?: string;
  /** 同场景可选技能 */
  allowedSkills?: string[];
};

export const SCENARIOS: Scenario[] = [
  {
    id: "general",
    title: "通用协作",
    summary: "项目内通用问答与协作，不强制绑定技能。",
    goal: "通用协作与问答。",
    recommendedTemplate: "自由对话",
    recommendedKnowledgeMode: "优先使用项目知识和指定集合",
    recommendedSections: [],
    systemContext: `你是技术品牌与技术推广协作助手。优先结合项目上下文回答；需要结构化交付物时引导用户切换到对应业务场景。`,
  },
  {
    id: "refine",
    title: "结果优化",
    summary: "对已有输出润色、扩写、重写或对齐口径。",
    goal: "对已有内容继续优化和重写。",
    recommendedTemplate: "优化改写",
    recommendedKnowledgeMode: "以源材料为主，知识库作补充",
    recommendedSections: [],
    systemContext: `在保留事实与关键结论的前提下，按任务说明优化给定材料；不要无依据新增技术参数或承诺。`,
  },
  {
    id: "tech-doc",
    title: "技术趋势洞察",
    summary: "行业趋势、品牌调研计划/报告与竞品对标。",
    goal: "输出可评审的趋势洞察或调研材料。",
    recommendedTemplate: "趋势洞察报告",
    recommendedKnowledgeMode: "优先使用知识集合并保留事实来源",
    recommendedSections: ["执行摘要", "行业洞察", "核心发现", "策略建议"],
    primarySkill: "tech_trend_skill",
    allowedSkills: [
      "tech_trend_skill",
      "brand_research_plan",
      "brand_research_report",
      "benchmark_skill",
    ],
    systemContext: `你是技术品牌洞察专家，擅长行业趋势、调研计划/报告与竞品对标；结论先行，标注假设与待核实项。`,
  },
  {
    id: "data-report",
    title: "技术IP包装策略",
    summary: "IP 全案、货架、矩阵、命名、互锁地图与车型赋能策略。",
    goal: "输出技术 IP 包装与品牌策略材料。",
    recommendedTemplate: "IP包装全案",
    recommendedKnowledgeMode: "优先使用项目知识和指定集合",
    recommendedSections: ["背景洞察", "IP定位", "包装策略", "车型互锁", "执行计划"],
    primarySkill: "ip_pack_skill",
    allowedSkills: [
      "ip_pack_skill",
      "ip_shelf_skill",
      "ip_matrix_skill",
      "brand_name_skill",
      "tech_lockmap_skill",
      "model_brand_skill",
    ],
    systemContext: `你是技术 IP 包装策略专家，擅长全案、货架、矩阵、命名与车型互锁；定位与信息屋需自洽。`,
  },
  {
    id: "prd",
    title: "技术传播策划",
    summary: "IP 传播方案、事件传播稿、素材清单与 A4 一页纸。",
    goal: "输出可落地的技术传播与公关材料。",
    recommendedTemplate: "传播策划方案",
    recommendedKnowledgeMode: "优先使用产品知识和标准术语口径",
    recommendedSections: ["传播目标", "受众分层", "核心信息", "节奏与渠道", "效果评估"],
    primarySkill: "ip_comm_plan",
    allowedSkills: ["ip_comm_plan", "tech_pr_skill", "material_skill", "a4_skill"],
    systemContext: `你是技术传播策划专家，输出需可直接用于传播评审：目标、受众、节奏、渠道与核心话术对齐。`,
  },
  {
    id: "marketing",
    title: "技术活动与展具",
    summary: "活动策划、展具概念/立项/说明书与 IP 认证方案。",
    goal: "输出技术活动或展具相关策划与交付文档。",
    recommendedTemplate: "活动策划方案",
    recommendedKnowledgeMode: "优先使用项目知识和指定集合",
    recommendedSections: ["活动概述", "参展目标", "展台/展具策略", "时间节点", "任务分工"],
    primarySkill: "event_plan_skill",
    allowedSkills: [
      "event_plan_skill",
      "display_concept_skill",
      "display_project_skill",
      "display_guide_skill",
      "ip_cert_plan",
    ],
    systemContext: `你是技术活动与展具策划专家，方案需明确目标、场地约束、互动体验、预算与排期。`,
  },
  {
    id: "debug",
    title: "领导讲稿与采访",
    summary: "发布会讲稿、发言稿与领导采访 QA。",
    goal: "输出可上台的讲稿或采访应答材料。",
    recommendedTemplate: "领导讲稿",
    recommendedKnowledgeMode: "优先结合项目上下文和标准口径",
    recommendedSections: ["开篇定调", "技术叙事", "用户价值", "号召与致谢"],
    primarySkill: "speech_draft_skill",
    allowedSkills: ["speech_draft_skill", "speech_skill", "interview_qa_skill"],
    systemContext: `你是领导讲稿与采访应答专家，口径统一、可朗读；敏感问题给桥梁话术，避免过度承诺。`,
  },
  {
    id: "kb-qa",
    title: "视频与销售赋能",
    summary: "导演脚本、短视频口播与销售话术手册。",
    goal: "输出视频脚本或销售一线赋能话术。",
    recommendedTemplate: "视频脚本",
    recommendedKnowledgeMode: "优先使用产品知识和标准术语口径",
    recommendedSections: ["核心创意", "分镜/口播结构", "证据点", "行动号召"],
    primarySkill: "video_script_skill",
    allowedSkills: ["video_script_skill", "video_skill", "sales_skill"],
    systemContext: `你是技术视频与销售赋能专家，内容可拍可讲；销售话术可落地到 4S 场景，证据点可核验。`,
  },
];

export const LOCAL_SCENARIO_IDS = new Set(SCENARIOS.map((s) => s.id));
