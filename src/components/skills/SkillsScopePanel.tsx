"use client";

import Link from "next/link";
import { skillLabel } from "@/lib/ui-labels";

export type SkillScopeItem = {
  id: string;
  name: string;
  description?: string;
  version: string;
  enabled: boolean;
  owner_id?: string;
};

type SkillsScopePanelProps = {
  skills: SkillScopeItem[];
  loading?: boolean;
  /** browse：单选查看详情；select：多选绑定 */
  mode?: "browse" | "select";
  selectedSkillId?: string | null;
  selectedNames?: string[];
  onSkillClick?: (skill: SkillScopeItem) => void;
  onToggleSelect?: (name: string) => void;
  showManageLink?: boolean;
  displayNameByName?: Map<string, string>;
  className?: string;
  emptyHint?: string;
};

function splitSkillsByScope(skills: SkillScopeItem[]) {
  const publicSkills = skills.filter((s) => !(s.owner_id && String(s.owner_id).trim()));
  const personalSkills = skills.filter((s) => !!(s.owner_id && String(s.owner_id).trim()));
  return { publicSkills, personalSkills };
}

function SkillScopeCard({
  skill,
  mode,
  active,
  selected,
  showManageLink,
  onSkillClick,
  onToggleSelect,
  displayNameByName,
}: {
  skill: SkillScopeItem;
  mode: "browse" | "select";
  active: boolean;
  selected: boolean;
  showManageLink: boolean;
  onSkillClick?: (skill: SkillScopeItem) => void;
  onToggleSelect?: (name: string) => void;
  displayNameByName?: Map<string, string>;
}) {
  const highlighted = mode === "browse" ? active : selected;
  const scopeLabel = skill.owner_id && String(skill.owner_id).trim() ? "个人" : "公共";
  const selectable = mode === "select" && skill.enabled;
  const displayName = skillLabel(skill.name, displayNameByName?.get(skill.name));

  return (
    <button
      key={skill.id}
      type="button"
      disabled={mode === "select" && !skill.enabled}
      onClick={() => {
        if (mode === "browse") onSkillClick?.(skill);
        else if (selectable) onToggleSelect?.(skill.name);
      }}
      className={`w-full rounded-lg border p-3 text-left transition ${
        highlighted
          ? "border-blue-500 bg-blue-600/20"
          : "border-slate-300 dark:border-slate-600 bg-slate-300/40 dark:bg-slate-700/40 hover:border-slate-500"
      } ${mode === "select" && !skill.enabled ? "cursor-not-allowed opacity-50" : ""}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{displayName}</span>
        <span
          className={`shrink-0 rounded-full px-1.5 py-0.5 text-xs ${
            skill.enabled ? "bg-green-500/20 text-green-400" : "bg-orange-500/20 text-orange-400"
          }`}
        >
          {skill.enabled ? "启用" : "禁用"}
        </span>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        v{skill.version} · {scopeLabel}
        {showManageLink ? (
          <>
            {" · "}
            <Link
              href={`/skills/${encodeURIComponent(skill.name)}`}
              className="text-blue-400 hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              管理
            </Link>
          </>
        ) : null}
      </p>
    </button>
  );
}

function SkillScopeSection({
  title,
  hint,
  skills,
  mode,
  selectedSkillId,
  selectedNames,
  showManageLink,
  onSkillClick,
  onToggleSelect,
  displayNameByName,
  emptyText,
}: {
  title: string;
  hint: string;
  skills: SkillScopeItem[];
  mode: "browse" | "select";
  selectedSkillId?: string | null;
  selectedNames: string[];
  showManageLink: boolean;
  onSkillClick?: (skill: SkillScopeItem) => void;
  onToggleSelect?: (name: string) => void;
  displayNameByName?: Map<string, string>;
  emptyText: string;
}) {
  return (
    <section>
      <h2 className="mb-1 text-lg font-semibold">{title}</h2>
      <p className="mb-3 text-xs text-slate-500">{hint}</p>
      {skills.length === 0 ? (
        <p className="py-4 text-center text-sm text-slate-500">{emptyText}</p>
      ) : (
        <div className="space-y-2">
          {skills.map((skill) => (
            <SkillScopeCard
              key={skill.id}
              skill={skill}
              mode={mode}
              active={selectedSkillId === skill.id}
              selected={selectedNames.includes(skill.name)}
              showManageLink={showManageLink}
              onSkillClick={onSkillClick}
              onToggleSelect={onToggleSelect}
              displayNameByName={displayNameByName}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function SkillsScopePanel({
  skills,
  loading = false,
  mode = "browse",
  selectedSkillId = null,
  selectedNames = [],
  onSkillClick,
  onToggleSelect,
  showManageLink = true,
  displayNameByName,
  className = "",
  emptyHint,
}: SkillsScopePanelProps) {
  const { publicSkills, personalSkills } = splitSkillsByScope(skills);

  if (loading) {
    return (
      <div
        className={`space-y-6 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-200/60 dark:bg-slate-800/60 p-4 ${className}`}
      >
        <p className="py-4 text-center text-sm text-slate-400">加载中…</p>
      </div>
    );
  }

  if (skills.length === 0) {
    return (
      <div
        className={`space-y-6 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-200/60 dark:bg-slate-800/60 p-4 ${className}`}
      >
        <p className="py-4 text-center text-sm text-slate-500">
          {emptyHint ?? "暂无已安装技能"}
        </p>
      </div>
    );
  }

  return (
    <div
      className={`space-y-6 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-200/60 dark:bg-slate-800/60 p-4 ${className}`}
    >
      <SkillScopeSection
        title="公共 / 工作区技能"
        hint="团队可复用的已安装能力"
        skills={publicSkills}
        mode={mode}
        selectedSkillId={selectedSkillId}
        selectedNames={selectedNames}
        showManageLink={showManageLink}
        onSkillClick={onSkillClick}
        onToggleSelect={onToggleSelect}
        displayNameByName={displayNameByName}
        emptyText="暂无公共技能条目"
      />
      <section className="border-t border-slate-300 dark:border-slate-700 pt-4">
        <SkillScopeSection
          title="我的技能"
          hint="本地上传，归属为个人技能"
          skills={personalSkills}
          mode={mode}
          selectedSkillId={selectedSkillId}
          selectedNames={selectedNames}
          showManageLink={showManageLink}
          onSkillClick={onSkillClick}
          onToggleSelect={onToggleSelect}
          displayNameByName={displayNameByName}
          emptyText="暂无上传技能，可使用技能页「上传技能」"
        />
      </section>
    </div>
  );
}
