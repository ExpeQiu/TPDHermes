"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CoCreateRouteSkeleton } from "@/app/projects/[id]/co-create/co-create-route-skeleton";
import { apiGet } from "@/lib/api";
import { useEffectiveUserScopeId } from "@/lib/use-effective-user-scope-id";
import { resolveCoCreateNavHref } from "@/lib/workflow-nav";

interface ProjectRow {
  id: string;
  status: string;
}

export default function CoCreateEntryPage() {
  const router = useRouter();
  const scopeUserId = useEffectiveUserScopeId();
  const [empty, setEmpty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const direct = resolveCoCreateNavHref(scopeUserId);
    if (direct.startsWith("/projects/") && direct.endsWith("/co-create")) {
      console.info("[co-create] 进入已选项目", { href: direct });
      router.replace(direct);
      return;
    }

    let cancelled = false;
    console.info("[co-create] 无最近项目，按项目列表进入");
    apiGet<ProjectRow[]>("/projects/")
      .then((projects) => {
        if (cancelled) return;
        const first = projects.find((project) => project.status !== "archived") ?? projects[0];
        if (!first) {
          console.info("[co-create] 没有可进入的项目");
          setEmpty(true);
          return;
        }
        const href = `/projects/${first.id}/co-create`;
        console.info("[co-create] 进入首个项目", { href });
        router.replace(href);
      })
      .catch((err: Error) => {
        console.error("[co-create] 打开失败", err);
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [router, scopeUserId]);

  if (empty) {
    return (
      <main className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="text-lg font-semibold text-slate-900 dark:text-white">还没有项目</h1>
        <p className="text-sm text-slate-500">新建项目后即可进入项目共创。</p>
        <Link
          href="/projects/new"
          className="rounded-xl bg-blue-600 px-5 py-3 text-sm font-medium text-white hover:bg-blue-500"
        >
          新建项目
        </Link>
      </main>
    );
  }

  if (error) {
    return (
      <main className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-6 text-center">
        <h1 className="text-lg font-semibold text-slate-900 dark:text-white">无法打开项目共创</h1>
        <p className="text-sm text-red-600 dark:text-red-300">{error}</p>
      </main>
    );
  }

  return <CoCreateRouteSkeleton />;
}
