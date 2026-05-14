"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { apiGet } from "@/lib/api";
import type { ChatInit, ProjectRecord } from "@/lib/chat-context";

type Scenario = {
  id: string;
  title: string;
  summary: string;
  goal: string;
  recommendedTemplate: string;
  recommendedKnowledgeMode: string;
  recommendedSections: string[];
  systemContext: string;
};

const SCENARIOS: Scenario[] = [
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

const CHAT_INIT_KEY = "tphermes-chat-init";
const DEFAULT_SCENARIO_ID = SCENARIOS[0]?.id ?? "general";

export default function CreatePage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-slate-950 text-sm text-slate-400">
          加载场景编排...
        </div>
      }
    >
      <CreatePageInner />
    </Suspense>
  );
}

function CreatePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectFromUrl = searchParams?.get("project") ?? "";
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [collections, setCollections] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedScenarioId, setSelectedScenarioId] = useState(DEFAULT_SCENARIO_ID);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedCollection, setSelectedCollection] = useState("");
  const [goal, setGoal] = useState("");
  const [deliverable, setDeliverable] = useState("");
  const [audience, setAudience] = useState("");
  const [brief, setBrief] = useState("");
  const [includeKnowledge, setIncludeKnowledge] = useState(true);
  const [includeSkills, setIncludeSkills] = useState(false);

  useEffect(() => {
    if (projectFromUrl) {
      setSelectedProjectId(projectFromUrl);
    }
  }, [projectFromUrl]);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      apiGet<ProjectRecord[]>("/projects/"),
      apiGet<{ collections: string[] }>("/kb/collections"),
    ]).then(([projectsRes, collectionsRes]) => {
      if (cancelled) return;
      const nextProjects = projectsRes.status === "fulfilled" ? projectsRes.value : [];
      const nextCollections =
        collectionsRes.status === "fulfilled" ? collectionsRes.value.collections : [];
      setProjects(nextProjects);
      setCollections(nextCollections);
      if (nextCollections.length > 0) {
        setSelectedCollection((current) => current || nextCollections[0] || "");
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedScenario =
    SCENARIOS.find((scenario) => scenario.id === selectedScenarioId) ?? SCENARIOS[0];
  const selectedProject = projects.find((project) => project.id === selectedProjectId);

  const systemContext = useMemo(() => {
    if (!selectedScenario) return "";
    return [
      selectedScenario.systemContext,
      "",
      "本次任务编排偏好：",
      `- 场景：${selectedScenario.title}`,
      `- 目标：${goal.trim() || selectedScenario.goal}`,
      `- 推荐模板：${deliverable.trim() || selectedScenario.recommendedTemplate}`,
      `- 推荐知识策略：${includeKnowledge ? selectedScenario.recommendedKnowledgeMode : "本次不额外启用知识集合"}`,
      `- 是否允许额外技能：${includeSkills ? "允许按需参考技能策略" : "不主动启用技能快照"}`,
      `- 项目绑定：${selectedProject ? selectedProject.name : "未绑定项目"}`,
      audience.trim() ? `- 目标受众：${audience.trim()}` : null,
      brief.trim() ? `- 业务补充：${brief.trim()}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }, [audience, brief, deliverable, goal, includeKnowledge, includeSkills, selectedProject, selectedScenario]);

  const opener = useMemo(() => {
    if (!selectedScenario) return "";
    return [
      `请基于当前任务编排，输出一版${deliverable.trim() || selectedScenario.recommendedTemplate}。`,
      `任务目标：${goal.trim() || selectedScenario.goal}`,
      audience.trim() ? `目标受众：${audience.trim()}` : null,
      brief.trim() ? `补充背景：${brief.trim()}` : null,
      `建议结构：${selectedScenario.recommendedSections.join("、")}`,
    ]
      .filter(Boolean)
      .join("\n");
  }, [audience, brief, deliverable, goal, selectedScenario]);

  const entrySummary = useMemo(() => {
    if (!selectedScenario) return "";
    return [
      "快捷编排摘要：",
      `- 场景：${selectedScenario.title}`,
      `- 项目：${selectedProject ? selectedProject.name : "未绑定项目"}`,
      `- 任务目标：${goal.trim() || selectedScenario.goal}`,
      `- 期望输出：${deliverable.trim() || selectedScenario.recommendedTemplate}`,
      `- 知识策略：${includeKnowledge ? selectedCollection || "按项目默认知识范围" : "不额外启用知识集合"}`,
      `- 技能策略：${includeSkills ? "允许携带技能策略" : "本次不主动启用技能快照"}`,
    ].join("\n");
  }, [deliverable, goal, includeKnowledge, includeSkills, selectedCollection, selectedProject, selectedScenario]);

  function navigateToChat() {
    if (!selectedScenario) return;
    const init: ChatInit = {
      scenarioId: selectedScenario.id,
      systemContext,
      opener,
      timestamp: Date.now(),
      projectId: selectedProject?.id,
      projectName: selectedProject?.name,
      selectedCollection: includeKnowledge ? selectedCollection || undefined : undefined,
      knowledgeEnabled: includeKnowledge,
      skillsEnabled: includeSkills,
      entrySummary,
    };
    if (typeof window !== "undefined") {
      try {
        sessionStorage.setItem(CHAT_INIT_KEY, JSON.stringify(init));
      } catch {
        // sessionStorage may be unavailable.
      }
    }

    const query = new URLSearchParams({
      scenario: selectedScenario.id,
      source: "quick-create",
    });
    if (selectedProject?.id) query.set("project", selectedProject.id);
    if (includeKnowledge && selectedCollection) query.set("collection", selectedCollection);
    if (includeSkills) query.set("skills", "1");
    router.push(`/chat?${query.toString()}`);
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-white">
      <header className="sticky top-0 z-10 border-b border-slate-700/50 bg-slate-900/60 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-4">
          <Link href="/" className="flex items-center gap-1.5 text-sm text-slate-400 transition hover:text-white">
            ← 首页
          </Link>
          <span className="text-slate-600">/</span>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold">快捷场景编排</h1>
          </div>
          <span className="ml-auto hidden text-xs text-slate-500 sm:block">
            先定义任务边界，再进入统一执行协作
          </span>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-6 pb-10 pt-12 text-center">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-600/20 px-4 py-1.5 text-sm text-blue-300">
          <span className="h-2 w-2 rounded-full bg-blue-400" aria-hidden />
          <span>场景编排入口</span>
        </div>
        <h2 className="mb-4 text-3xl font-bold sm:text-4xl">
          不再只选提示词，先组装一份 <span className="text-blue-400">任务合同</span>
        </h2>
        <p className="mx-auto max-w-3xl text-base leading-relaxed text-slate-400">
          选择场景后补充项目、知识与输出偏好，再进入对话协作页。这样前端负责声明任务边界，而不是拼装一段长提示词。
        </p>
      </section>

      <main className="mx-auto max-w-6xl px-6 pb-16">
        <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
          <section className="space-y-6">
            <div className="rounded-3xl border border-slate-800 bg-slate-900/50 p-6">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Step 1</p>
                  <h3 className="mt-2 text-xl font-semibold">选择场景</h3>
                </div>
                <p className="text-sm text-slate-500">共 {SCENARIOS.length} 个常用任务入口</p>
              </div>
              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                {SCENARIOS.map((scenario) => {
                  const active = scenario.id === selectedScenarioId;
                  return (
                    <button
                      key={scenario.id}
                      type="button"
                      onClick={() => setSelectedScenarioId(scenario.id)}
                      className={`rounded-2xl border p-5 text-left transition ${
                        active
                          ? "border-blue-500 bg-blue-500/10 shadow-lg shadow-blue-950/20"
                          : "border-slate-700 bg-slate-950/60 hover:border-slate-600 hover:bg-slate-900/70"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h4 className="text-base font-semibold text-white">{scenario.title}</h4>
                          <p className="mt-2 text-sm leading-relaxed text-slate-400">
                            {scenario.summary}
                          </p>
                        </div>
                        <span
                          className={`mt-1 h-2.5 w-2.5 rounded-full ${
                            active ? "bg-blue-400" : "bg-slate-600"
                          }`}
                          aria-hidden
                        />
                      </div>
                      <div className="mt-4 flex flex-wrap gap-2">
                        <span className="rounded-full border border-slate-700 px-2.5 py-1 text-xs text-slate-300">
                          {scenario.recommendedTemplate}
                        </span>
                        <span className="rounded-full border border-slate-700 px-2.5 py-1 text-xs text-slate-400">
                          {scenario.recommendedKnowledgeMode}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="rounded-3xl border border-slate-800 bg-slate-900/50 p-6">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Step 2</p>
                <h3 className="mt-2 text-xl font-semibold">补充任务边界</h3>
              </div>

              <div className="mt-5 grid gap-4 md:grid-cols-2">
                <label className="space-y-2 text-sm">
                  <span className="text-slate-300">关联项目</span>
                  <select
                    value={selectedProjectId}
                    onChange={(e) => setSelectedProjectId(e.target.value)}
                    className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none transition focus:border-blue-500"
                  >
                    <option value="">暂不绑定项目</option>
                    {projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="space-y-2 text-sm">
                  <span className="text-slate-300">知识集合</span>
                  <select
                    value={selectedCollection}
                    onChange={(e) => setSelectedCollection(e.target.value)}
                    disabled={collections.length === 0 || !includeKnowledge}
                    className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-3 text-sm text-white outline-none transition focus:border-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {collections.length === 0 ? (
                      <option value="">暂无集合</option>
                    ) : (
                      collections.map((collection) => (
                        <option key={collection} value={collection}>
                          {collection}
                        </option>
                      ))
                    )}
                  </select>
                </label>

                <label className="space-y-2 text-sm">
                  <span className="text-slate-300">任务目标</span>
                  <input
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    placeholder={selectedScenario?.goal}
                    className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-3 text-sm text-white placeholder:text-slate-500 outline-none transition focus:border-blue-500"
                  />
                </label>

                <label className="space-y-2 text-sm">
                  <span className="text-slate-300">期望输出</span>
                  <input
                    value={deliverable}
                    onChange={(e) => setDeliverable(e.target.value)}
                    placeholder={selectedScenario?.recommendedTemplate}
                    className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-3 text-sm text-white placeholder:text-slate-500 outline-none transition focus:border-blue-500"
                  />
                </label>

                <label className="space-y-2 text-sm">
                  <span className="text-slate-300">目标受众</span>
                  <input
                    value={audience}
                    onChange={(e) => setAudience(e.target.value)}
                    placeholder="例如：客户技术负责人、项目评审会、市场团队"
                    className="w-full rounded-xl border border-slate-700 bg-slate-950/70 px-4 py-3 text-sm text-white placeholder:text-slate-500 outline-none transition focus:border-blue-500"
                  />
                </label>

                <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                  <p className="text-sm font-medium text-white">策略开关</p>
                  <div className="mt-4 space-y-3 text-sm">
                    <label className="flex items-center justify-between gap-3">
                      <span className="text-slate-300">启用知识策略</span>
                      <input
                        type="checkbox"
                        checked={includeKnowledge}
                        onChange={(e) => setIncludeKnowledge(e.target.checked)}
                      />
                    </label>
                    <label className="flex items-center justify-between gap-3">
                      <span className="text-slate-300">携带技能策略</span>
                      <input
                        type="checkbox"
                        checked={includeSkills}
                        onChange={(e) => setIncludeSkills(e.target.checked)}
                      />
                    </label>
                  </div>
                </div>
              </div>

              <label className="mt-4 block space-y-2 text-sm">
                <span className="text-slate-300">补充背景</span>
                <textarea
                  value={brief}
                  onChange={(e) => setBrief(e.target.value)}
                  rows={5}
                  placeholder="补充业务背景、现有材料、禁止事项或必须覆盖的信息"
                  className="w-full rounded-2xl border border-slate-700 bg-slate-950/70 px-4 py-3 text-sm text-white placeholder:text-slate-500 outline-none transition focus:border-blue-500"
                />
              </label>
            </div>
          </section>

          <aside className="space-y-6">
            <div className="rounded-3xl border border-slate-800 bg-slate-900/50 p-6">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Step 3</p>
                <h3 className="mt-2 text-xl font-semibold">任务合同预览</h3>
              </div>

              <div className="mt-5 space-y-4">
                <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                  <p className="text-xs uppercase tracking-[0.16em] text-slate-500">Scenario</p>
                  <p className="mt-2 text-base font-semibold text-white">{selectedScenario?.title}</p>
                  <p className="mt-2 text-sm leading-relaxed text-slate-400">
                    {selectedScenario?.summary}
                  </p>
                </div>

                <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-slate-500">项目</span>
                    <span className="text-right text-slate-200">
                      {selectedProject ? selectedProject.name : "未绑定"}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <span className="text-slate-500">任务目标</span>
                    <span className="text-right text-slate-200">
                      {goal.trim() || selectedScenario?.goal}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <span className="text-slate-500">期望输出</span>
                    <span className="text-right text-slate-200">
                      {deliverable.trim() || selectedScenario?.recommendedTemplate}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <span className="text-slate-500">知识策略</span>
                    <span className="text-right text-slate-200">
                      {includeKnowledge ? selectedCollection || "按默认策略" : "关闭"}
                    </span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <span className="text-slate-500">技能策略</span>
                    <span className="text-right text-slate-200">
                      {includeSkills ? "允许参考技能" : "关闭"}
                    </span>
                  </div>
                </div>

                <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                  <p className="text-sm font-medium text-white">建议章节</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {selectedScenario?.recommendedSections.map((section) => (
                      <span
                        key={section}
                        className="rounded-full border border-slate-700 px-2.5 py-1 text-xs text-slate-300"
                      >
                        {section}
                      </span>
                    ))}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={navigateToChat}
                  className="w-full rounded-2xl bg-blue-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-blue-500"
                >
                  进入编排协作
                </button>

                <p className="text-xs leading-relaxed text-slate-500">
                  进入对话页后会自动带入场景摘要、项目绑定和知识策略，作为当前任务的前端声明信息。
                </p>
              </div>
            </div>

            <div className="rounded-3xl border border-slate-800 bg-slate-900/50 p-6">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Current State</p>
              <h3 className="mt-2 text-xl font-semibold">为何这样改</h3>
              <div className="mt-4 space-y-3 text-sm leading-relaxed text-slate-400">
                <p>旧版快速创作只负责把固定提示词带到对话页，无法表达项目、知识范围和期望输出。</p>
                <p>新版先显式收集任务边界，再跳转到统一执行页面，更接近编排工作流。</p>
                <p>当前仍复用现有对话链路，属于兼容层升级，后续可以继续接入更完整的任务接口能力。</p>
              </div>
            </div>
          </aside>
        </div>

        <div className="mt-10 text-center text-sm text-slate-600">
          {loading ? "正在加载项目与知识集合..." : "快捷编排页已按工作流方式组织：场景 -> 边界 -> 进入执行"}
        </div>
      </main>
    </div>
  );
}
