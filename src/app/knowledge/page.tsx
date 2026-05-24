import { Suspense } from "react";

import KnowledgePageClient from "./KnowledgePageClient";

export default function KnowledgePage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-[40vh] flex items-center justify-center text-slate-500 text-sm">
          加载知识库…
        </div>
      }
    >
      <KnowledgePageClient />
    </Suspense>
  );
}
