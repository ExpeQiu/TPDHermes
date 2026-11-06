"use client";

import RoleManagementPanel from "@/components/settings/RoleManagementPanel";

export default function OpsRolesPage() {
  return (
    <section aria-label="Roles">
      <p className="text-sm text-slate-500 dark:text-slate-400">
        配置可复用角色 Agent（圆桌 / Consult）；Pack 按 id 引用并合并；写入 multi_agent/roles/*.yml。
      </p>
      <div className="mt-4">
        <RoleManagementPanel />
      </div>
    </section>
  );
}
