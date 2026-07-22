"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useUserAccess } from "@/lib/admin-access";
import {
  WORKFLOW_NAV_ITEMS,
  type WorkflowNavItem,
} from "@/lib/workflow-nav";
import type { FeatureKey } from "@/lib/rbac";
import { useEffectiveUserScopeId } from "@/lib/use-effective-user-scope-id";

function isNavItemActive(item: WorkflowNavItem, pathname: string): boolean {
  if (item.matchActive) return item.matchActive(pathname);
  if (item.href === "/") return pathname === "/";
  return pathname.startsWith(item.href.split("?")[0] ?? item.href);
}

function navItemHref(item: WorkflowNavItem, scopeUserId: string, mounted: boolean): string {
  if (item.resolveHref && mounted) return item.resolveHref(scopeUserId);
  return item.href;
}

export default function GlobalWorkflowNav() {
  const pathname = usePathname();
  const scopeUserId = useEffectiveUserScopeId();
  const { canAccess, ready } = useUserAccess();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const navItems = useMemo(() => {
    const isRestricted = (item: (typeof WORKFLOW_NAV_ITEMS)[number]) =>
      Boolean(item.requiredFeature || item.adminOnly);

    // 权限未就绪时隐藏受限入口，避免无权限用户短暂看到「场景编排 / 知识库」等
    if (!mounted || !ready) {
      return WORKFLOW_NAV_ITEMS.filter((item) => !isRestricted(item));
    }

    return WORKFLOW_NAV_ITEMS.filter((item) => {
      if (item.requiredFeature) return canAccess(item.requiredFeature);
      if (item.adminOnly) {
        return canAccess("create" as FeatureKey) || canAccess("knowledge" as FeatureKey);
      }
      return true;
    });
  }, [mounted, ready, canAccess]);

  return (
    <header className="z-40 shrink-0 border-b border-slate-200 bg-white/85 backdrop-blur-md dark:border-slate-800 dark:bg-slate-950/85">
      <div className="flex items-center justify-between gap-3 py-3">
        <div className="flex shrink-0 items-center pl-4 sm:pl-6 md:pl-8">
          <Link
            href="/"
            className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 transition hover:border-slate-300 hover:bg-slate-100 dark:border-slate-800 dark:bg-slate-900/70 dark:hover:border-slate-700 dark:hover:bg-slate-900"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-600 text-sm font-semibold text-white">
              G
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-900 dark:text-white">TPCM</p>
              <p className="text-xs text-slate-500">技术推广内容共创工作台</p>
            </div>
          </Link>
        </div>

        <nav
          className="flex min-w-0 shrink items-center gap-2 overflow-x-auto pb-1 pr-4 sm:pr-6 md:pr-8 lg:justify-end"
          aria-label="全站工作流导航"
        >
          {navItems.map((item) => {
            const active = isNavItemActive(item, pathname);
            const href = navItemHref(item, scopeUserId, mounted);
            return (
              <Link
                key={item.shortLabel}
                href={href}
                className={`inline-flex w-[5.5rem] shrink-0 items-center justify-center whitespace-nowrap rounded-full border px-2 py-2 text-center text-sm transition ${
                  active
                    ? "border-blue-500/40 bg-blue-500/15 text-blue-700 dark:text-blue-200"
                    : "border-slate-200 bg-slate-100 text-slate-600 hover:border-slate-300 hover:bg-slate-200 hover:text-slate-900 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-400 dark:hover:border-slate-700 dark:hover:bg-slate-900 dark:hover:text-slate-200"
                }`}
              >
                {item.shortLabel}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
