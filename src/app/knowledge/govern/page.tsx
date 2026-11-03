import { Suspense } from "react";

import AdminOnlyPageGuard from "@/components/admin-only-page-guard";
import KnowledgePageClient from "../KnowledgePageClient";

export default function KnowledgeGovernPage() {
  return (
    <AdminOnlyPageGuard pageTitle="knowledge/govern" feature="knowledge">
      <Suspense
        fallback={
          <div className="min-h-[40vh] flex items-center justify-center text-slate-500 text-sm">
            加载知识库治理…
          </div>
        }
      >
        <KnowledgePageClient surface="govern" />
      </Suspense>
    </AdminOnlyPageGuard>
  );
}
