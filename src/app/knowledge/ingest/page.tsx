import { Suspense } from "react";

import AdminOnlyPageGuard from "@/components/admin-only-page-guard";
import KnowledgePageClient from "../KnowledgePageClient";

export default function KnowledgeIngestPage() {
  return (
    <AdminOnlyPageGuard pageTitle="knowledge/ingest" feature="knowledge">
      <Suspense
        fallback={
          <div className="min-h-[40vh] flex items-center justify-center text-slate-500 text-sm">
            加载上传导入…
          </div>
        }
      >
        <KnowledgePageClient surface="ingest" />
      </Suspense>
    </AdminOnlyPageGuard>
  );
}
