"use client";

import Link from "next/link";

import { useIsDefaultAdmin } from "@/lib/admin-access";

export default function AdminOnlyPageGuard({
  children,
  pageTitle,
}: {
  children: React.ReactNode;
  pageTitle: string;
}) {
  const { isAdmin, ready } = useIsDefaultAdmin();

  if (!ready) {
    return (
      <main className="min-h-[40vh] flex items-center justify-center text-sm text-slate-500">
        正在校验访问权限…
      </main>
    );
  }

  if (!isAdmin) {
    return (
      <main className="min-h-[40vh] flex items-center justify-center p-6">
        <div className="max-w-md rounded-2xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-5 text-center">
          <p className="text-sm text-amber-800 dark:text-amber-200">
            <code>/{pageTitle}</code> 仅管理员可见。
          </p>
          <Link href="/" className="mt-3 inline-block text-sm text-blue-600 dark:text-blue-300 hover:underline">
            返回首页
          </Link>
        </div>
      </main>
    );
  }

  return <>{children}</>;
}

