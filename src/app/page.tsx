import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "首页",
  description: "以项目与编排为中心，统一串联需求澄清、任务执行、结果沉淀与优化协作。",
};

const workflowSteps = [
  {
    title: "定义边界",
    desc: "在项目中沉淀背景、受众、约束与交付目标，形成长期生效的业务上下文。",
    accent: "from-blue-600 to-cyan-500",
  },
  {
    title: "编排任务",
    desc: "按场景选择知识范围、技能策略与输出形态，生成本次任务合同。",
    accent: "from-violet-600 to-fuchsia-500",
  },
  {
    title: "协作执行",
    desc: "在对话中持续澄清需求、查看任务边界，并通过统一链路触发生成。",
    accent: "from-emerald-600 to-teal-500",
  },
  {
    title: "沉淀输出",
    desc: "将结果回收到项目，保留输出历史、执行记录与后续优化入口。",
    accent: "from-amber-500 to-orange-500",
  },
] as const;

const entries = [
  {
    href: "/projects",
    title: "项目中心",
    desc: "围绕项目查看长期边界、任务入口与结果沉淀，作为工作流主入口。",
    accent: "from-blue-600 to-indigo-600",
    eyebrow: "Project",
  },
  {
    href: "/create",
    title: "场景编排",
    desc: "从快捷场景发起任务，配置项目、知识与期望输出，再进入执行协作。",
    accent: "from-sky-600 to-blue-500",
    eyebrow: "Compose",
  },
  {
    href: "/chat",
    title: "编排协作",
    desc: "围绕结构化任务持续对话、补充约束和查看当前编排预览。",
    accent: "from-violet-600 to-purple-700",
    eyebrow: "Run",
  },
  {
    href: "/workshop",
    title: "结果工坊",
    desc: "承接定向生成与内容优化，逐步收敛到统一的任务执行链路。",
    accent: "from-slate-600 to-slate-800",
    eyebrow: "Refine",
  },
  {
    href: "/knowledge",
    title: "知识策略",
    desc: "浏览集合、验证检索状态，并为后续项目知识范围配置提供基础。",
    accent: "from-emerald-600 to-teal-700",
    eyebrow: "Knowledge",
  },
  {
    href: "/skills",
    title: "技能策略",
    desc: "管理可复用技能资产，支撑编排中的白名单、偏好与定向执行。",
    accent: "from-amber-600 to-orange-600",
    eyebrow: "Skills",
  },
] as const;

export default function Home() {
  return (
    <div className="relative min-h-dvh overflow-x-hidden bg-slate-950 text-slate-100">
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(59,130,246,0.22),transparent)]"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_60%_40%_at_100%_50%,rgba(139,92,246,0.12),transparent)]"
        aria-hidden
      />

      <main className="relative mx-auto flex min-h-dvh max-w-6xl flex-col px-4 pb-16 pt-12 sm:px-6 sm:pt-16 md:pt-20 lg:px-8">
        <header className="home-animate-in mx-auto max-w-4xl text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-200">
            <span className="h-2 w-2 rounded-full bg-blue-400" aria-hidden />
            统一任务编排工作台
          </div>
          <p className="mt-5 text-xs font-medium uppercase tracking-[0.2em] text-slate-500">
            TPDHermes
          </p>
          <h1 className="mt-3 text-balance bg-gradient-to-b from-white to-slate-400 bg-clip-text text-4xl font-semibold tracking-tight text-transparent sm:text-5xl md:text-6xl">
            让前端围绕项目与工作流协作，而不是围绕孤立页面跳转
          </h1>
          <p className="mx-auto mt-5 max-w-3xl text-pretty text-base leading-relaxed text-slate-400 sm:text-lg">
            从项目边界、场景编排、执行协作到输出沉淀，前端现在以统一工作流组织入口，减少提示词式跳转和模块割裂。
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/create"
              className="inline-flex min-w-40 items-center justify-center rounded-xl bg-blue-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-blue-500"
            >
              发起场景编排
            </Link>
            <Link
              href="/projects"
              className="inline-flex min-w-40 items-center justify-center rounded-xl border border-slate-700 bg-slate-900/60 px-5 py-3 text-sm font-medium text-slate-200 transition hover:border-slate-600 hover:bg-slate-900"
            >
              进入项目中心
            </Link>
          </div>
        </header>

        <section
          className="home-animate-in mt-12 grid gap-4 sm:grid-cols-2 lg:mt-16 lg:grid-cols-4"
          style={{ animationDelay: "80ms" }}
          aria-label="工作流阶段"
        >
          {workflowSteps.map((item, index) => (
            <div
              key={item.title}
              className="rounded-2xl border border-slate-800/80 bg-slate-900/40 p-5 shadow-lg shadow-black/20"
            >
              <div className="flex items-center justify-between">
                <div
                  className={`h-1.5 w-12 rounded-full bg-gradient-to-r ${item.accent}`}
                  aria-hidden
                />
                <span className="text-xs font-medium text-slate-500">0{index + 1}</span>
              </div>
              <h2 className="mt-5 text-lg font-semibold text-white">{item.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">{item.desc}</p>
            </div>
          ))}
        </section>

        <section
          className="home-animate-in mt-8 grid gap-4 lg:grid-cols-[1.25fr_0.75fr]"
          style={{ animationDelay: "120ms" }}
        >
          <div className="rounded-3xl border border-slate-800/80 bg-slate-900/40 p-6 shadow-lg shadow-black/20">
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">
              Workflow Focus
            </p>
            <h2 className="mt-3 text-2xl font-semibold text-white">新的前端信息架构</h2>
            <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {entries.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="group relative flex flex-col rounded-2xl border border-slate-800/80 bg-slate-950/70 p-5 outline-none ring-slate-700/0 transition-[transform,box-shadow,border-color,background-color] duration-200 hover:-translate-y-0.5 hover:border-slate-600/80 hover:bg-slate-900/80 hover:shadow-xl hover:shadow-black/20 focus-visible:ring-2 focus-visible:ring-blue-500/60"
                >
                  <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500">
                    {item.eyebrow}
                  </p>
                  <div
                    className={`mt-4 h-1 w-12 rounded-full bg-gradient-to-r ${item.accent}`}
                    aria-hidden
                  />
                  <h3 className="mt-4 text-lg font-semibold text-white group-hover:text-white">
                    {item.title}
                  </h3>
                  <p className="mt-2 flex-1 text-sm leading-relaxed text-slate-400">
                    {item.desc}
                  </p>
                  <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-blue-400 transition-colors group-hover:text-blue-300">
                    进入
                    <span
                      className="translate-x-0 transition-transform duration-200 group-hover:translate-x-0.5"
                      aria-hidden
                    >
                      →
                    </span>
                  </span>
                </Link>
              ))}
            </div>
          </div>

          <div className="rounded-3xl border border-slate-800/80 bg-slate-900/40 p-6 shadow-lg shadow-black/20">
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">
              Design Rules
            </p>
            <h2 className="mt-3 text-2xl font-semibold text-white">前端改造原则</h2>
            <div className="mt-6 space-y-4 text-sm leading-relaxed text-slate-300">
              <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                <p className="font-medium text-white">项目优先</p>
                <p className="mt-1 text-slate-400">项目承担长期约束，不再只是 CRUD 容器。</p>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                <p className="font-medium text-white">编排优先</p>
                <p className="mt-1 text-slate-400">前端提交结构化任务，不再让页面负责提示词拼装。</p>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                <p className="font-medium text-white">结果闭环</p>
                <p className="mt-1 text-slate-400">对话、工坊、快捷创作都应回到输出与执行记录。</p>
              </div>
            </div>
          </div>
        </section>

        <footer className="home-animate-in mt-auto pt-16 text-center text-xs text-slate-600" style={{ animationDelay: "160ms" }}>
          <p>从项目或场景编排入口开始，逐步形成统一工作流</p>
        </footer>
      </main>
    </div>
  );
}
