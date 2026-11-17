"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { apiGet, apiPost } from "@/lib/api";
import { DEFAULT_PROMOTION_PRODUCTS } from "@/lib/promotion-package";

interface ProjectFile {
  id: string;
  kind: string;
  title: string;
}

interface PackageSummary {
  id: string;
  updated_at?: string;
}

export default function PromotionEntryPage() {
  const params = useParams<{ id: string }>();
  const projectId = String(params.id || "");
  const router = useRouter();
  const [message, setMessage] = useState("正在打开快捷创作…");

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    async function openWorkspace() {
      const listed = await apiGet<{ items: PackageSummary[] }>(`/projects/${projectId}/promotion-packages`);
      const latest = [...(listed.items ?? [])].sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""))[0];
      if (latest) {
        console.info("[promotion] open existing", { projectId, packageId: latest.id });
        router.replace(`/projects/${projectId}/promotion/${latest.id}?tab=materials`);
        return;
      }
      const files = await apiGet<{ items: ProjectFile[] }>(`/projects/${projectId}/files`);
      const refs = (files.items ?? []).map((file) => ({ file_id: file.id, kind: file.kind }));
      if (!refs.length) {
        if (!cancelled) setMessage("这个项目还没有资料，先在项目里放入文件后再打开快捷创作。");
        return;
      }
      const created = await apiPost<{ id: string }>(`/projects/${projectId}/promotion-packages`, {
        idempotency_key: `promo-${projectId}`,
        products: [...DEFAULT_PROMOTION_PRODUCTS],
        file_refs: refs,
      });
      console.info("[promotion] open created", { projectId, packageId: created.id, files: refs.length });
      router.replace(`/projects/${projectId}/promotion/${created.id}?tab=materials`);
    }
    void openWorkspace().catch((err: Error) => {
      if (!cancelled) setMessage(err.message || "打开快捷创作失败");
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, router]);

  return (
    <main className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6 md:p-8">
      <p className="text-sm text-slate-500" role="status">{message}</p>
      <Link href={`/projects/${projectId}`} className="mt-4 inline-block text-sm text-slate-500">返回项目</Link>
    </main>
  );
}
