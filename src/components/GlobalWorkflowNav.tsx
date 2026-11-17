"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useUserAccess } from "@/lib/admin-access";
import {
  WORKFLOW_NAV_ITEMS,
  groupWorkflowNavEntries,
  isWorkflowPageAccessible,
  type WorkflowNavItem,
} from "@/lib/workflow-nav";
import { useEffectiveUserScopeId } from "@/lib/use-effective-user-scope-id";
import UserAccountMenu from "@/components/UserAccountMenu";

const navLinkClass = (active: boolean, widthClass: string) =>
  `inline-flex ${widthClass} shrink-0 items-center justify-center whitespace-nowrap rounded-md border px-2 py-2 text-center text-sm transition ${
    active
      ? "border-blue-500/40 bg-blue-500/15 text-blue-700 dark:text-blue-200"
      : "border-slate-200 bg-slate-100 text-slate-600 hover:border-slate-300 hover:bg-slate-200 hover:text-slate-900 dark:border-slate-800 dark:bg-slate-900/60 dark:text-slate-400 dark:hover:border-slate-700 dark:hover:bg-slate-900 dark:hover:text-slate-200"
  }`;

function isNavItemActive(item: WorkflowNavItem, pathname: string): boolean {
  if (item.matchActive) return item.matchActive(pathname);
  if (item.href === "/") return pathname === "/";
  return pathname.startsWith(item.href.split("?")[0] ?? item.href);
}

function navItemHref(item: WorkflowNavItem, scopeUserId: string, mounted: boolean): string {
  if (item.resolveHref && mounted) return item.resolveHref(scopeUserId);
  return item.href;
}

function ContentCreationMenu({
  items,
  pathname,
  scopeUserId,
  mounted,
}: {
  items: WorkflowNavItem[];
  pathname: string;
  scopeUserId: string;
  mounted: boolean;
}) {
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [menuBox, setMenuBox] = useState<{ top: number; left: number; width: number } | null>(null);
  const active = items.some((item) => isNavItemActive(item, pathname));

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return;
      setMenuBox({ top: rect.bottom + 6, left: rect.left, width: Math.max(rect.width, 112) });
    };
    place();
    console.info("[workflow-nav] 打开内容创作中心", {
      targets: items.map((item) => ({ label: item.label, href: navItemHref(item, scopeUserId, mounted) })),
    });
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (buttonRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest(`[data-menu-id="${menuId}"]`)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, items, menuId, mounted, scopeUserId]);

  const menu =
    open && menuBox && mounted
      ? createPortal(
          <div
            data-menu-id={menuId}
            id={menuId}
            role="menu"
            style={{ top: menuBox.top, left: menuBox.left, minWidth: menuBox.width }}
            className="fixed z-50 flex flex-col gap-1 rounded-md border border-slate-200 bg-white/95 p-1 shadow-lg backdrop-blur-md dark:border-slate-800 dark:bg-slate-950/95"
          >
            {items.map((item) => {
              const childActive = isNavItemActive(item, pathname);
              return (
                <Link
                  key={item.label}
                  href={navItemHref(item, scopeUserId, mounted)}
                  role="menuitem"
                  className={navLinkClass(childActive, "w-full")}
                  onClick={() => setOpen(false)}
                >
                  {item.shortLabel}
                </Link>
              );
            })}
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        className={`${navLinkClass(active || open, "w-auto px-3")} gap-1`}
        onClick={() => setOpen((value) => !value)}
      >
        内容创作中心
        <svg
          viewBox="0 0 12 12"
          aria-hidden="true"
          className={`h-3 w-3 shrink-0 transition ${open ? "rotate-180" : ""}`}
        >
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>
      {menu}
    </>
  );
}

export default function GlobalWorkflowNav() {
  const pathname = usePathname();
  const scopeUserId = useEffectiveUserScopeId();
  const { access, ready } = useUserAccess();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const navEntries = useMemo(() => {
    // 权限未就绪时隐藏受限入口，避免无权限用户短暂看到「场景编排 / 知识库」等
    const visible =
      !mounted || !ready || !access
        ? WORKFLOW_NAV_ITEMS.filter((item) => isWorkflowPageAccessible(item, null))
        : WORKFLOW_NAV_ITEMS.filter((item) =>
            isWorkflowPageAccessible(item, {
              features: access.features,
              platformRole: access.platform_role,
            }),
          );
    return groupWorkflowNavEntries(visible);
  }, [mounted, ready, access]);

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

        <div className="flex min-w-0 flex-1 items-center justify-end gap-3 pr-4 sm:pr-6 md:pr-8">
        <nav
          className="flex min-w-0 flex-1 items-center justify-end gap-2 overflow-x-auto pb-1"
          aria-label="全站工作流导航"
        >
          {navEntries.map((entry) => {
            if (entry.kind === "group") {
              return (
                <ContentCreationMenu
                  key={entry.id}
                  items={entry.items}
                  pathname={pathname}
                  scopeUserId={scopeUserId}
                  mounted={mounted}
                />
              );
            }
            const item = entry.item;
            const active = isNavItemActive(item, pathname);
            const href = navItemHref(item, scopeUserId, mounted);
            return (
              <Link key={item.shortLabel} href={href} className={navLinkClass(active, item.shortLabel.length > 4 ? "w-[6.25rem]" : "w-[5.5rem]")}>
                {item.shortLabel}
              </Link>
            );
          })}
        </nav>
        <UserAccountMenu />
        </div>
      </div>
    </header>
  );
}
