"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { useUserAccess } from "@/lib/admin-access";
import type { FeatureKey } from "@/lib/rbac";

export function FeaturePageGuard({
  children,
  feature,
  pageTitle,
}: {
  children: React.ReactNode;
  feature: FeatureKey;
  pageTitle: string;
}) {
  const { canAccess, ready } = useUserAccess();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // 避免 SSR 与客户端 localStorage 权限缓存不一致导致 hydration 报错
  if (!mounted || !ready) {
    return (
      <main className="min-h-[40vh] flex items-center justify-center text-sm text-slate-500">
        正在校验访问权限…
      </main>
    );
  }

  if (!canAccess(feature)) {
    return (
      <main className="min-h-[40vh] flex items-center justify-center p-6">
        <div className="max-w-md rounded-2xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-5 text-center">
          <p className="text-sm text-amber-800 dark:text-amber-200">
            <code>/{pageTitle}</code> 当前角色无权访问。
          </p>
          <Link
            href="/settings?tab=identity"
            className="mt-3 mr-3 inline-block text-sm text-blue-600 dark:text-blue-300 hover:underline"
          >
            调整角色
          </Link>
          <Link href="/" className="mt-3 inline-block text-sm text-blue-600 dark:text-blue-300 hover:underline">
            返回首页
          </Link>
        </div>
      </main>
    );
  }

  return <>{children}</>;
}

export default function AdminOnlyPageGuard({
  children,
  pageTitle,
  feature = "create",
}: {
  children: React.ReactNode;
  pageTitle: string;
  feature?: FeatureKey;
}) {
  return (
    <FeaturePageGuard feature={feature} pageTitle={pageTitle}>
      {children}
    </FeaturePageGuard>
  );
}
