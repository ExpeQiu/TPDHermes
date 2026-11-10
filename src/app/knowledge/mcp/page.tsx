import { Suspense } from "react";

import AdminOnlyPageGuard from "@/components/admin-only-page-guard";
import KnowledgePageClient from "../KnowledgePageClient";

export default function KnowledgeMcpPage() {
  return (
    <AdminOnlyPageGuard pageTitle="knowledge/mcp" feature="knowledge">
      <Suspense
        fallback={
          <div className="min-h-[40vh] flex items-center justify-center text-slate-500 text-sm">
            加载 MCP 接入…
          </div>
        }
      >
        <KnowledgePageClient surface="mcp" />
      </Suspense>
    </AdminOnlyPageGuard>
  );
}
