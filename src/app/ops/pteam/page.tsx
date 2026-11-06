"use client";

import PackManagementPanel from "@/components/settings/PackManagementPanel";

export default function OpsPteamPage() {
  return (
    <section aria-label="P-team">
      <p className="text-sm text-slate-500 dark:text-slate-400">
        组装 multi-agent 领域协作包：圆桌席位与 Consult 专家；配置写入 multi_agent/skill_packs/*/pack.yml。
      </p>
      <div className="mt-4">
        <PackManagementPanel />
      </div>
    </section>
  );
}
