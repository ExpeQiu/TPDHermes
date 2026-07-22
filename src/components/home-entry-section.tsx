"use client";

import Link from "next/link";

import { useUserAccess } from "@/lib/admin-access";
import type { FeatureKey } from "@/lib/rbac";

type EntryItem = {
  href: string;
  title: string;
  desc: string;
  accent: string;
  eyebrow: string;
  adminOnly?: boolean;
  requiredFeature?: FeatureKey;
};

const HREF_FEATURE: Partial<Record<string, FeatureKey>> = {
  "/create": "create",
  "/knowledge": "knowledge",
  "/skills": "skills",
};

export default function HomeEntrySection({ entries }: { entries: readonly EntryItem[] }) {
  const { canAccess, isAdmin, ready } = useUserAccess();
  const visibleEntries = entries.filter((item) => {
    const feature = item.requiredFeature ?? HREF_FEATURE[item.href];
    if (feature) {
      if (!ready) return false;
      return canAccess(feature);
    }
    if (item.adminOnly) return ready && isAdmin;
    return true;
  });

  return (
    <section
      className="home-animate-in mt-10 lg:mt-14"
      style={{ animationDelay: "80ms" }}
      aria-label="功能入口"
    >
      <div className="rounded-3xl border border-slate-200/80 dark:border-slate-800/80 bg-slate-100/80 dark:bg-slate-900/40 p-6 shadow-lg shadow-black/20">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">入口</p>
        <h2 className="mt-2 text-xl font-semibold text-slate-900 dark:text-white sm:text-2xl">开始工作</h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visibleEntries.map((item) => (
            <Link
              key={`${item.href}-${item.title}`}
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
  );
}
