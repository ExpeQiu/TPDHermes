"use client";

import StudioSkillReleasePanel from "@/components/settings/StudioSkillReleasePanel";

export default function OpsStudioSkillsPage() {
  return (
    <section aria-label="技能卡">
      <p className="text-sm text-slate-500 dark:text-slate-400">
        管理场景创作里对用户开放的技能卡。仍在开发或验证中的卡片默认关闭，打开后才会出现在场景创作侧栏。
      </p>
      <StudioSkillReleasePanel />
    </section>
  );
}
