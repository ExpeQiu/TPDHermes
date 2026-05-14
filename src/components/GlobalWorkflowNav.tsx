"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { getWorkflowNavItem, WORKFLOW_NAV_ITEMS } from "@/lib/workflow-nav";

export default function GlobalWorkflowNav() {
  const pathname = usePathname();
  const activeItem = getWorkflowNavItem(pathname);

  return (
    <header className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/85 backdrop-blur-md">
      <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/70 px-3 py-2 transition hover:border-slate-700 hover:bg-slate-900"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 text-sm font-semibold text-white">
                TH
              </div>
              <div>
                <p className="text-sm font-semibold text-white">TPDHermes</p>
                <p className="text-xs text-slate-500">统一任务编排工作台</p>
              </div>
            </Link>

            <div className="hidden rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2 md:block">
              <p className="text-[11px] uppercase tracking-[0.16em] text-slate-500">当前入口</p>
              <p className="mt-1 text-sm font-medium text-white">{activeItem.label}</p>
            </div>
          </div>

          <nav
            className="flex items-center gap-2 overflow-x-auto pb-1 lg:justify-end"
            aria-label="全站工作流导航"
          >
            {WORKFLOW_NAV_ITEMS.map((item) => {
              const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`whitespace-nowrap rounded-full border px-3 py-2 text-sm transition ${
                    active
                      ? "border-blue-500/40 bg-blue-500/15 text-blue-200"
                      : "border-slate-800 bg-slate-900/60 text-slate-400 hover:border-slate-700 hover:bg-slate-900 hover:text-slate-200"
                  }`}
                >
                  {item.shortLabel}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="mt-3 flex items-center justify-between gap-3 text-xs text-slate-500">
          <p>{activeItem.description}</p>
          <p className="hidden sm:block">统一层级：项目中心 -&gt; 场景编排 -&gt; 编排协作 -&gt; 结果工坊</p>
        </div>
      </div>
    </header>
  );
}
