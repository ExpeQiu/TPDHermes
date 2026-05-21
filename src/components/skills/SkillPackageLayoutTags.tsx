"use client";

import Link from "next/link";
import { accentBlue, accentGreen, accentLink } from "@/lib/theme-text";

export const SKILL_LAYOUT_ITEMS: Array<{
  key: string;
  label: string;
  required?: boolean;
  creatable?: boolean;
  openPath?: string;
}> = [
  { key: "SKILL.md", label: "SKILL.md（核心规则）", required: true, creatable: true, openPath: "SKILL.md" },
  { key: "scripts", label: "scripts/（可执行脚本）", creatable: true },
  { key: "references", label: "references/（参考文档）", creatable: true },
  { key: "assets", label: "assets/（素材资源）", creatable: true },
  { key: "__init__.py", label: "__init__.py（TPD Python 技能）", creatable: true, openPath: "__init__.py" },
  { key: "skill.json", label: "skill.json（模版元数据）", creatable: true, openPath: "skill.json" },
];

export function layoutScore(layout: Record<string, boolean> | null | undefined): number {
  if (!layout) return 0;
  return ["SKILL.md", "scripts", "references", "assets"].filter((k) => layout[k]).length;
}

type SkillPackageLayoutTagsProps = {
  layout: Record<string, boolean> | null | undefined;
  loading?: boolean;
  /** readonly：仅展示；interactive：可点击新增/打开 */
  mode?: "readonly" | "interactive";
  skillName?: string;
  creatingItem?: string | null;
  onCreateItem?: (key: string) => void;
  onOpenFile?: (path: string) => void;
  manageHref?: string;
  className?: string;
};

export function SkillPackageLayoutTags({
  layout,
  loading = false,
  mode = "readonly",
  skillName,
  creatingItem = null,
  onCreateItem,
  onOpenFile,
  manageHref,
  className = "",
}: SkillPackageLayoutTagsProps) {
  const interactive = mode === "interactive";

  const handleClick = (item: (typeof SKILL_LAYOUT_ITEMS)[number]) => {
    const ok = Boolean(layout?.[item.key]);
    if (!interactive) return;
    if (ok && item.openPath && onOpenFile) {
      onOpenFile(item.openPath);
      return;
    }
    if (!ok && item.creatable && onCreateItem) {
      onCreateItem(item.key);
    }
  };

  if (loading) {
    return <p className={`text-xs text-slate-500 ${className}`}>加载包结构…</p>;
  }

  return (
    <div className={className}>
      <ul className="grid gap-2 sm:grid-cols-2">
        {SKILL_LAYOUT_ITEMS.map((item) => {
          const ok = Boolean(layout?.[item.key]);
          const canCreate = interactive && !ok && item.creatable;
          const canOpen = interactive && ok && Boolean(item.openPath);
          const isInteractive = canCreate || canOpen;
          const busy = creatingItem === item.key;

          const baseClass = ok
            ? "border-green-500/50 bg-green-500/15 text-green-800 ring-1 ring-green-500/30 dark:text-green-200"
            : item.required
              ? "border-amber-500/50 bg-amber-50 text-amber-900 dark:border-amber-600/40 dark:bg-amber-500/10 dark:text-amber-100"
              : "border-slate-300 bg-slate-100/80 text-slate-600 dark:border-slate-600 dark:bg-slate-800/50 dark:text-slate-300";

          const inner = (
            <>
              <span className={ok ? accentGreen : "text-slate-500 dark:text-slate-400"}>{ok ? "✓" : "○"}</span>
              <span className="flex-1 text-left">{item.label}</span>
              {canCreate && (
                <span className={`shrink-0 text-[10px] ${accentBlue}`}>
                  {busy ? "创建中…" : "点击新增"}
                </span>
              )}
              {canOpen && (
                <span className={`shrink-0 text-[10px] ${accentGreen} opacity-90`}>点击查看</span>
              )}
              {mode === "readonly" && !ok && manageHref && (
                <span className="shrink-0 text-[10px] text-slate-500">未创建</span>
              )}
            </>
          );

          if (!isInteractive) {
            return (
              <li
                key={item.key}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${baseClass}`}
              >
                {inner}
              </li>
            );
          }

          return (
            <li key={item.key}>
              <button
                type="button"
                disabled={busy}
                onClick={() => handleClick(item)}
                className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-xs transition disabled:opacity-60 ${baseClass} ${
                  canCreate
                    ? "cursor-pointer hover:border-blue-500/50 hover:bg-blue-500/10 hover:text-blue-800 dark:hover:text-blue-200"
                    : "cursor-pointer hover:bg-green-500/20"
                }`}
              >
                {inner}
              </button>
            </li>
          );
        })}
      </ul>
      {manageHref && mode === "readonly" && skillName && (
        <p className="mt-2 text-xs text-slate-500">
          符合度 {layoutScore(layout)}/4 ·{" "}
          <Link href={manageHref} className={`${accentLink} hover:underline`}>
            在「{skillName}」详情中管理文件
          </Link>
        </p>
      )}
      {interactive && (
        <p className="mt-2 text-xs text-slate-500">
          绿色为已存在（文件项可点击查看）；灰色/琥珀色项点击即可新增空白模板。符合度 {layoutScore(layout)}/4。
        </p>
      )}
    </div>
  );
}
