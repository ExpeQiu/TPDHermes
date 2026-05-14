import type { Metadata } from "next";
import Link from "next/link";
import { CONTENT_MAX_CLASS } from "@/lib/content-shell";

export const metadata: Metadata = {
  title: "首页",
  description: "以项目与编排为中心，统一串联需求澄清、任务执行、结果沉淀与优化协作。",
};

const entries = [
  {
    href: "/projects",
    title: "项目中心",
    desc: "项目与任务主入口",
    accent: "from-blue-600 to-indigo-600",
    eyebrow: "Project",
  },
  {
    href: "/create",
    title: "场景编排",
    desc: "创建和维护可复用场景",
    accent: "from-sky-600 to-blue-500",
    eyebrow: "Compose",
  },
  {
    href: "/chat",
    title: "编排协作",
    desc: "对话与任务执行",
    accent: "from-violet-600 to-purple-700",
    eyebrow: "Run",
  },
  {
    href: "/workshop",
    title: "结果工坊",
    desc: "在项目中基于场景生成结果",
    accent: "from-slate-600 to-slate-800",
    eyebrow: "Refine",
  },
  {
    href: "/knowledge",
    title: "知识策略",
    desc: "集合与检索",
    accent: "from-emerald-600 to-teal-700",
    eyebrow: "Knowledge",
  },
  {
    href: "/skills",
    title: "技能策略",
    desc: "安装与启用技能",
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

      <main
        className={`relative flex min-h-dvh flex-col px-4 pb-16 pt-12 sm:px-6 sm:pt-16 md:px-8 md:pt-20 ${CONTENT_MAX_CLASS}`}
      >
        <header className="home-animate-in mx-auto max-w-4xl text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-200">
            <span className="h-2 w-2 rounded-full bg-blue-400" aria-hidden />
            统一任务编排工作台
          </div>
          <p className="mt-5 text-xs font-medium uppercase tracking-[0.2em] text-slate-500">
            TPDHermes
          </p>
          <h1 className="mt-3 text-balance bg-gradient-to-b from-white to-slate-400 bg-clip-text text-3xl font-semibold tracking-tight text-transparent sm:text-4xl md:text-5xl">
            项目与编排协作工作台
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-pretty text-sm text-slate-400 sm:text-base">
            从项目、场景编排进入对话与工坊，统一任务边界与输出沉淀。
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/create"
              className="inline-flex min-w-40 items-center justify-center rounded-xl bg-blue-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-blue-500"
            >
              发起场景编排
            </Link>
            <Link
              href="/workshop"
              className="inline-flex min-w-40 items-center justify-center rounded-xl border border-slate-700 bg-slate-900/60 px-5 py-3 text-sm font-medium text-slate-200 transition hover:border-slate-600 hover:bg-slate-900"
            >
              打开结果工坊
            </Link>
            <Link
              href="/projects"
              className="inline-flex min-w-40 items-center justify-center rounded-xl border border-slate-800 bg-slate-950/50 px-5 py-3 text-sm font-medium text-slate-300 transition hover:border-slate-600 hover:bg-slate-900/80"
            >
              项目中心
            </Link>
          </div>
        </header>

        <section
          className="home-animate-in mt-10 lg:mt-14"
          style={{ animationDelay: "80ms" }}
          aria-label="功能入口"
        >
          <div className="rounded-3xl border border-slate-800/80 bg-slate-900/40 p-6 shadow-lg shadow-black/20">
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">入口</p>
            <h2 className="mt-2 text-xl font-semibold text-white sm:text-2xl">开始工作</h2>
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
                  <p className="mt-1 text-sm text-slate-500">{item.desc}</p>
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
        </section>

        <footer className="home-animate-in mt-12 pt-8 text-center text-xs text-slate-600" style={{ animationDelay: "120ms" }}>
          <p>TPDHermes</p>
        </footer>
      </main>
    </div>
  );
}
