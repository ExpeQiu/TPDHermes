"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { FeaturePageGuard } from "@/components/admin-only-page-guard";
import { CONTENT_MAX_CLASS, PAGE_MAIN_CLASS } from "@/lib/content-shell";

const OPS_TABS = [
  { href: "/ops/employees", label: "数字员工" },
  { href: "/ops/usage", label: "功能使用统计" },
  { href: "/ops/learning", label: "学习中心" },
  { href: "/ops/pteam", label: "P-team" },
  { href: "/ops/roles", label: "Roles" },
  { href: "/ops/studio-skills", label: "技能卡" },
] as const;

export function OpsFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <FeaturePageGuard feature="ops" pageTitle="ops">
      <main className={PAGE_MAIN_CLASS}>
        <div className={CONTENT_MAX_CLASS}>
          <Link
            href="/"
            className="text-sm text-slate-500 transition hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
          >
            ← 返回首页
          </Link>
          <h1 className="mt-4 text-3xl font-bold text-slate-900 dark:text-white sm:text-4xl">成长</h1>
          <div
            role="tablist"
            aria-label="成长分类"
            className="mt-8 flex flex-wrap gap-2 border-b border-slate-200 dark:border-slate-800"
          >
            {OPS_TABS.map((tab) => {
              const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  role="tab"
                  aria-selected={active}
                  className={`-mb-px rounded-t-lg px-4 py-2.5 text-sm font-medium transition ${
                    active
                      ? "border border-b-transparent border-slate-200 bg-white text-slate-900 dark:border-slate-800 dark:bg-slate-900/50 dark:text-white"
                      : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
                  }`}
                >
                  {tab.label}
                </Link>
              );
            })}
          </div>
          <div className="mt-6">{children}</div>
        </div>
      </main>
    </FeaturePageGuard>
  );
}
