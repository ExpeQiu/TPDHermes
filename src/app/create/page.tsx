"use client";

import { useRouter } from "next/navigation";

type Scenario = {
  id: string;
  icon: string;
  title: string;
  description: string;
  tag: string;
  systemContext: string;
  opener: string;
};

const SCENARIOS: Scenario[] = [
  {
    id: "tech-doc",
    icon: "📝",
    title: "技术文档写作",
    description: "API 文档、SDK 说明、技术方案、白皮书等专业内容输出",
    tag: "技术写作",
    systemContext: `你是一位资深技术写作专家，擅长：
- 撰写清晰、准确、专业的技术文档
- 将复杂的技术概念用通俗易懂的语言解释
- 按照行业标准（如ISO/IEC/IEEE）组织文档结构
- 提供完整的代码示例和最佳实践

输出风格：专业、简洁、结构化，适合开发者和技术人员阅读。`,
    opener: "请帮我撰写一份关于【主题】的技术文档，包含概述、核心概念、详细说明、代码示例和常见问题。",
  },
  {
    id: "data-report",
    icon: "📊",
    title: "数据分析报告",
    description: "市场分析、用户洞察、业务复盘等结构化报告生成",
    tag: "分析报告",
    systemContext: `你是一位专业的数据分析师，擅长：
- 从数据中发现业务洞察和机会
- 将数据转化为可执行的策略建议
- 构建清晰的叙事逻辑，结论先行
- 使用图表描述和替代方案（如有数据）

输出风格：数据驱动、逻辑严谨、结论前置，建议具体可落地。`,
    opener: "请基于【数据/背景信息】输出一份数据分析报告，包含核心发现、关键洞察和行动建议。",
  },
  {
    id: "prd",
    icon: "🎯",
    title: "产品需求文档",
    description: "PRD、用户故事、功能规格说明等产品文档快速起草",
    tag: "产品文档",
    systemContext: `你是一位资深产品经理，擅长：
- 撰写结构完整、逻辑清晰的产品需求文档（PRD）
- 拆解用户故事，定义功能范围和验收标准
- 平衡用户体验、技术可行性和业务价值
- 识别边界情况和依赖关系

输出风格：专业、条理清晰、用词精准，适合跨团队协作和评审。`,
    opener: "请帮我撰写一份【产品名称】的产品需求文档（PRD），包含产品概述、用户故事、功能需求、非功能需求和优先级。",
  },
  {
    id: "marketing",
    icon: "📢",
    title: "营销推广文案",
    description: "产品卖点提炼、传播话术、活动文案等多形式内容创作",
    tag: "营销内容",
    systemContext: `你是一位顶尖的技术品牌营销专家，擅长：
- 提炼技术亮点并转化为受众语言
- 撰写有传播力的标题、导语和核心文案
- 适配不同平台和场景（官网/公众号/微博/短视频等）
- 将技术叙事与品牌价值有机结合

输出风格：精准、有吸引力、具备传播势能，适合市场推广和品牌传播场景。`,
    opener: "请为【产品/技术】撰写一套营销推广文案，覆盖核心卖点、主标题、副标题和行动号召。",
  },
  {
    id: "debug",
    icon: "🔧",
    title: "故障排查报告",
    description: "问题定位、根因分析、复盘总结和修复方案文档化",
    tag: "运维支撑",
    systemContext: `你是一位经验丰富的 SRE/运维工程师，擅长：
- 系统性排查线上故障，快速定位根因
- 撰写结构化的故障报告（TimeLine + Root Cause + Action）
- 输出可落地的改进措施和预防方案
- 将技术细节翻译为业务影响说明

输出风格：客观、详实、以解决问题为导向，适合事后复盘和团队分享。`,
    opener: "【故障描述】：请帮我输出一份故障排查报告，包含问题时间线、根因分析、影响评估和后续改进措施。",
  },
  {
    id: "kb-qa",
    icon: "💡",
    title: "知识库问答",
    description: "基于文档库的知识检索、摘要提取和问答对生成",
    tag: "知识管理",
    systemContext: `你是一位专业的知识管理专家，擅长：
- 从长文档中快速提取关键信息和知识点
- 生成精准的问答对（Q&A），用于知识库建设
- 将分散信息归纳为结构化的知识图谱或手册
- 用通俗语言解释专业概念

输出风格：简洁、准确、易于理解，适合知识沉淀和团队培训。`,
    opener: "【背景材料】：请基于以下内容生成知识问答对，并整理出核心知识点摘要。",
  },
];

// Storage key for carrying context to chat page
const CHAT_INIT_KEY = "tphermes-chat-init";

interface ChatInit {
  scenarioId: string;
  systemContext: string;
  opener: string;
  timestamp: number;
}

function navigateToChat(router: ReturnType<typeof useRouter>, scenario: Scenario) {
  const init: ChatInit = {
    scenarioId: scenario.id,
    systemContext: scenario.systemContext,
    opener: scenario.opener,
    timestamp: Date.now(),
  };
  if (typeof window !== "undefined") {
    try {
      sessionStorage.setItem(CHAT_INIT_KEY, JSON.stringify(init));
    } catch {
      // sessionStorage may be unavailable (e.g. private mode)
    }
  }
  router.push(`/chat?scenario=${scenario.id}&source=quick-create`);
}

export default function CreatePage() {
  const router = useRouter();

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="border-b border-slate-700/50 bg-slate-900/60 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center gap-4">
          <a href="/" className="text-slate-400 hover:text-white transition text-sm flex items-center gap-1.5">
            ← 首页
          </a>
          <span className="text-slate-600">/</span>
          <div className="flex items-center gap-2">
            <span className="text-lg">⚡</span>
            <h1 className="text-lg font-semibold">快速创作</h1>
          </div>
          <span className="ml-auto text-xs text-slate-500 hidden sm:block">
            选择场景，跳转对话，自动带入上下文
          </span>
        </div>
      </header>

      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <section className="max-w-6xl mx-auto px-6 pt-12 pb-10 text-center">
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-blue-600/20 border border-blue-500/30 text-blue-300 text-sm mb-6">
          <span>⚡</span>
          <span>快速创作入口</span>
        </div>
        <h2 className="text-3xl sm:text-4xl font-bold mb-4">
          选场景，<span className="text-blue-400">一键进入</span>创作状态
        </h2>
        <p className="text-slate-400 max-w-2xl mx-auto text-base">
          6 大常用创作场景，点击后自动跳转对话界面，预设系统上下文和开场白，
          让 AI 快速进入角色，省去反复提示的烦恼。
        </p>
      </section>

      {/* ── Cards Grid ────────────────────────────────────────────────────── */}
      <main className="max-w-6xl mx-auto px-6 pb-16">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {SCENARIOS.map((scenario) => (
            <button
              key={scenario.id}
              onClick={() => navigateToChat(router, scenario)}
              className="group relative text-left rounded-2xl border border-slate-700/60 bg-slate-800/50 p-6 backdrop-blur-sm transition-all duration-200 hover:border-blue-500/50 hover:bg-slate-800 hover:shadow-xl hover:shadow-blue-900/20 hover:-translate-y-0.5"
            >
              {/* Tag badge */}
              <div className="absolute top-4 right-4">
                <span className="text-xs px-2 py-0.5 rounded-full bg-slate-700/80 text-slate-400 border border-slate-600/50">
                  {scenario.tag}
                </span>
              </div>

              {/* Icon */}
              <div className="w-12 h-12 rounded-xl bg-slate-700/60 flex items-center justify-center text-2xl mb-4 group-hover:bg-blue-600/20 group-hover:scale-110 transition-all duration-200">
                {scenario.icon}
              </div>

              {/* Title & description */}
              <h3 className="text-base font-semibold text-white group-hover:text-blue-300 transition-colors mb-2">
                {scenario.title}
              </h3>
              <p className="text-sm text-slate-400 leading-relaxed">
                {scenario.description}
              </p>

              {/* Preview opener hint */}
              <div className="mt-4 pt-4 border-t border-slate-700/40">
                <p className="text-xs text-slate-500 line-clamp-2 italic">
                  &ldquo;{scenario.opener}&rdquo;
                </p>
              </div>

              {/* Hover CTA */}
              <div className="mt-3 flex items-center gap-1 text-sm text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                <span>开始创作</span>
                <span>→</span>
              </div>
            </button>
          ))}
        </div>

        {/* ── Footer note ──────────────────────────────────────────────── */}
        <div className="mt-10 text-center">
          <p className="text-sm text-slate-600">
            提示：每个场景预设了系统上下文，也可进入对话后补充具体信息获得更精准结果
          </p>
        </div>
      </main>
    </div>
  );
}
