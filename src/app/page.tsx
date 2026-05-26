import type { Metadata } from "next";
import Link from "next/link";
import { CONTENT_MAX_CLASS } from "@/lib/content-shell";

export const metadata: Metadata = {
  title: "首页",
  description: "以项目为主入口，对话创作与场景输出为生产路径，场景编排与知识、技能为支撑层。",
};

const entries = [
  {
    href: "/projects",
    title: "项目管理",
    desc: "主入口：进入项目后发起对话创作或场景输出",
    accent: "from-blue-600 to-indigo-600",
    eyebrow: "项目",
  },
  {
    href: "/chat",
    title: "对话创作",
    desc: "基于项目的开放式多轮协作",
    accent: "from-violet-600 to-purple-700",
    eyebrow: "对话",
  },
  {
    href: "/workshop",
    title: "场景输出",
    desc: "在项目内按已绑定场景生成与沉淀结果",
    accent: "from-slate-600 to-slate-800",
    eyebrow: "工坊",
  },
  {
    href: "/create",
    title: "场景编排",
    desc: "维护场景（说明、技能、模版与规则）",
    accent: "from-sky-600 to-blue-500",
    eyebrow: "编排",
  },
  {
    href: "/knowledge",
    title: "知识策略",
    desc: "集合与检索",
    accent: "from-emerald-600 to-teal-700",
    eyebrow: "知识",
  },
  {
    href: "/skills",
    title: "技能策略",
    desc: "安装与启用技能",
    accent: "from-amber-600 to-orange-600",
    eyebrow: "技能",
  },
] as const;

export default function Home() {
  return (
    <div className="relative min-h-dvh overflow-x-hidden bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
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
          <h1 className="mt-3 text-balance bg-gradient-to-b from-slate-900 to-slate-500 bg-clip-text text-3xl font-semibold tracking-tight text-transparent dark:from-white dark:to-slate-400 sm:text-4xl md:text-5xl">
            技术推广内容共创平台
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-pretty text-sm text-slate-400 sm:text-base">
            从项目进入对话创作与场景输出；场景编排、知识与技能用于配置与支撑。
          </p>
          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link
              href="/projects"
              className="inline-flex min-w-40 items-center justify-center rounded-xl bg-blue-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-blue-500"
            >
              进入项目管理
            </Link>
            <Link
              href="/chat"
              className="inline-flex min-w-40 items-center justify-center rounded-xl border border-slate-300 dark:border-slate-700 bg-white/90 dark:bg-slate-900/60 px-5 py-3 text-sm font-medium text-slate-800 dark:text-slate-200 transition hover:border-slate-300 dark:border-slate-600 hover:bg-slate-200 dark:hover:bg-slate-900"
            >
              对话创作
            </Link>
            <Link
              href="/workshop"
              className="inline-flex min-w-40 items-center justify-center rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-100/70 dark:bg-slate-950/50 px-5 py-3 text-sm font-medium text-slate-700 dark:text-slate-300 transition hover:border-slate-300 dark:border-slate-600 hover:bg-slate-200/80 dark:hover:bg-slate-900/80"
            >
              场景输出
            </Link>
          </div>
        </header>

        <section
          className="home-animate-in mt-10 lg:mt-14"
          style={{ animationDelay: "80ms" }}
          aria-label="功能入口"
        >
          <div className="rounded-3xl border border-slate-200/80 dark:border-slate-800/80 bg-slate-100/80 dark:bg-slate-900/40 p-6 shadow-lg shadow-black/20">
            <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">入口</p>
            <h2 className="mt-2 text-xl font-semibold text-slate-900 dark:text-white sm:text-2xl">开始工作</h2>
            <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {entries.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="group relative flex flex-col rounded-2xl border border-slate-200/80 dark:border-slate-800/80 bg-slate-100 dark:bg-slate-950/70 p-5 outline-none ring-slate-700/0 transition-[transform,box-shadow,border-color,background-color] duration-200 hover:-translate-y-0.5 hover:border-slate-300 dark:border-slate-600/80 hover:bg-slate-200/80 dark:hover:bg-slate-900/80 hover:shadow-xl hover:shadow-black/20 focus-visible:ring-2 focus-visible:ring-blue-500/60"
                >
                  <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500">
                    {item.eyebrow}
                  </p>
                  <div
                    className={`mt-4 h-1 w-12 rounded-full bg-gradient-to-r ${item.accent}`}
                    aria-hidden
                  />
                  <h3 className="mt-4 text-lg font-semibold text-slate-900 dark:text-white group-hover:text-slate-900 dark:hover:text-white">
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
          <p>2026@TPCM</p>
        </footer>
      </main>
    </div>
  );
}
