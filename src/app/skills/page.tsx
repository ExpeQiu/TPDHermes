"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import { apiFetch, readJson } from "@/lib/api";
import { CONTENT_MAX_CLASS } from "@/lib/content-shell";
import { SkillPackageLayoutTags } from "@/components/skills/SkillPackageLayoutTags";
import { SkillsScopePanel } from "@/components/skills/SkillsScopePanel";
import { skillLabel, skillScopeLabel } from "@/lib/ui-labels";
import { trackUsage } from "@/lib/usage-tracker";

interface Skill {
    id: string;
    name: string;
    description: string;
    version: string;
    enabled: boolean;
    source: string;
    /** public：工作区/市场；personal：本地上传 */
    scope?: string;
    owner_id?: string;
    owner_type?: string;
    visibility?: string;
    config: Record<string, unknown>;
  version_history: Array<{ version: string; changelog: string; installed_at: string }>;
  installed_at: string;
  updated_at: string;
}

type SkillMetaRow = {
  name: string;
  display_name?: string;
};

const SKILLS_BASE = "/skills/";

function MetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/50 p-4">
      <p className="text-xs uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-3 text-2xl font-semibold text-slate-900 dark:text-white">{value}</p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

export default function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [packageLayout, setPackageLayout] = useState<Record<string, boolean> | null>(null);
  const [packageLoading, setPackageLoading] = useState(false);
  const [actionMsg, setActionMsg] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadNameHint, setUploadNameHint] = useState("");
  const [skillMeta, setSkillMeta] = useState<SkillMetaRow[]>([]);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const fetchSkills = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [skillsRes, metaRes] = await Promise.allSettled([
        apiFetch(SKILLS_BASE).then((res) => readJson<Skill[]>(res)),
        apiFetch("/ws/skills/metadata").then((res) =>
          readJson<{ skills: SkillMetaRow[] }>(res),
        ),
      ]);
      if (skillsRes.status === "fulfilled") {
        setSkills(skillsRes.value);
      } else {
        throw skillsRes.reason;
      }
      if (metaRes.status === "fulfilled") {
        setSkillMeta(metaRes.value.skills ?? []);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "加载失败";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  useEffect(() => {
    trackUsage({
      eventName: "skills_page_view",
      feature: "skills",
      action: "view",
    });
  }, []);

  const skillDisplayByName = useMemo(
    () =>
      new Map(
        skillMeta
          .map((m) => [m.name, m.display_name?.trim() ?? ""] as const)
          .filter(([, displayName]) => displayName.length > 0),
      ),
    [skillMeta],
  );

  const selectedSkillTitle = selectedSkill
    ? skillLabel(selectedSkill.name, skillDisplayByName.get(selectedSkill.name))
    : "";

  const showMsg = (msg: string) => {
    setActionMsg(msg);
    setTimeout(() => setActionMsg(""), 3000);
  };

  const handleToggle = async (skill: Skill) => {
    trackUsage({
      eventName: "skills_toggle_click",
      feature: "skills",
      action: "toggle_click",
      properties: { skill_name: skill.name, enabled_to: !skill.enabled },
    });
    try {
      const res = await apiFetch(`${SKILLS_BASE}${skill.name}/enable`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !skill.enabled }),
      });
      await readJson(res);
      await fetchSkills();
      showMsg(`${skill.name} 已${!skill.enabled ? "启用" : "禁用"}`);
    } catch (e: unknown) {
      showMsg(`操作失败: ${e instanceof Error ? e.message : ""}`);
    }
  };

  const handleUninstall = async (name: string) => {
    if (!confirm(`确定要卸载技能「${name}」吗？`)) return;
    trackUsage({
      eventName: "skills_uninstall_click",
      feature: "skills",
      action: "uninstall_click",
      properties: { skill_name: name },
    });
    try {
      const res = await apiFetch(`${SKILLS_BASE}${name}`, { method: "DELETE" });
      await readJson(res);
      setSelectedSkill(null);
      await fetchSkills();
      showMsg(`「${name}」已卸载`);
    } catch (e: unknown) {
      showMsg(`卸载失败: ${e instanceof Error ? e.message : ""}`);
    }
  };

  const fetchPackageLayout = useCallback(async (name: string) => {
    setPackageLoading(true);
    setPackageLayout(null);
    try {
      const res = await apiFetch(`${SKILLS_BASE}${encodeURIComponent(name)}/package`);
      const data = await readJson<{ standard_layout: Record<string, boolean> }>(res);
      setPackageLayout(data.standard_layout);
    } catch {
      setPackageLayout(null);
    } finally {
      setPackageLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedSkill?.name) {
      fetchPackageLayout(selectedSkill.name);
    } else {
      setPackageLayout(null);
    }
  }, [selectedSkill?.name, fetchPackageLayout]);

  const triggerSkillUpload = () => uploadInputRef.current?.click();

  const handleSkillZipSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    trackUsage({
      eventName: "skills_upload_select",
      feature: "skills",
      action: "upload_select",
      properties: { file_name: file.name, size: file.size },
    });
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const hint = uploadNameHint.trim();
      if (hint) fd.append("name", hint);
      const res = await apiFetch("/skills/upload", { method: "POST", body: fd });
      const installed = await readJson<Skill>(res);
      await fetchSkills();
      setUploadNameHint("");
      setSelectedSkill(installed);
      showMsg(`已从 ZIP 安装「${installed.name}」`);
    } catch (err: unknown) {
      showMsg(`上传失败: ${err instanceof Error ? err.message : ""}`);
    } finally {
      setUploading(false);
    }
  };

  const installedCount = skills.filter((s) => s.enabled).length;
  const disabledCount = skills.length - installedCount;

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100 p-4 text-slate-900 sm:p-6 md:p-8 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 dark:text-white">
      <div className={CONTENT_MAX_CLASS}>
        <div className="mb-8">
          <div className="mb-3 flex items-center gap-3">
            <Link href="/" className="text-sm text-slate-400 transition hover:text-slate-900 dark:hover:text-white">
              ← 返回首页
            </Link>
          </div>
          <div className="inline-flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-200">
            <span className="h-2 w-2 rounded-full bg-amber-400" aria-hidden />
            技能策略入口
          </div>
          <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h1 className="text-3xl font-bold sm:text-4xl">技能策略</h1>
              <p className="mt-2 max-w-2xl text-sm text-slate-400 sm:text-base">
                <span className="text-slate-800 dark:text-slate-200">公共技能</span>（工作区与市场安装）与
                <span className="text-slate-800 dark:text-slate-200">我的技能</span>（本地上传 ZIP）分区管理；启用状态参与编排白名单。
              </p>
            </div>
            <div className="flex flex-col items-stretch gap-2 sm:items-end">
              <div className="flex flex-wrap gap-2">
                <Link
                  href="/skills/market"
                  className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium transition hover:bg-blue-500"
                >
                  访问技能市场
                </Link>
                <button
                  type="button"
                  disabled={uploading}
                  onClick={triggerSkillUpload}
                  className="rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900/70 px-4 py-2.5 text-sm font-medium text-slate-800 dark:text-slate-200 transition hover:border-slate-300 dark:border-slate-600 hover:bg-slate-200 dark:hover:bg-slate-900 disabled:opacity-50"
                >
                  {uploading ? "上传中…" : "上传技能"}
                </button>
                <input
                  ref={uploadInputRef}
                  type="file"
                  accept=".zip,application/zip"
                  className="sr-only"
                  aria-label="选择技能 ZIP 包"
                  onChange={handleSkillZipSelected}
                />
              </div>
              <input
                type="text"
                value={uploadNameHint}
                onChange={(ev) => setUploadNameHint(ev.target.value)}
                placeholder="ZIP 根目录即包时填写目录名"
                className="w-full min-w-[12rem] max-w-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900/80 px-3 py-2 text-xs text-slate-800 dark:text-slate-200 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>
        </div>

        <div className="mb-6 grid grid-cols-1 gap-3 md:grid-cols-4">
          <MetricCard label="已安装" value={String(skills.length)} hint="当前本地能力池" />
          <MetricCard label="启用中" value={String(installedCount)} hint="可参与任务执行" />
          <MetricCard label="已禁用" value={String(disabledCount)} hint="保留但不主动使用" />
          <MetricCard label="策略目标" value="核心 / 偏好 / 自学习" />
        </div>

        {actionMsg && (
          <div className="mb-4 px-4 py-3 bg-blue-600/20 border border-blue-600/40 rounded-lg text-blue-300 text-sm">
            {actionMsg}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mb-4 px-4 py-3 bg-red-600/20 border border-red-600/40 rounded-lg text-red-300 text-sm">
            ❌ {error}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1">
            <SkillsScopePanel
              skills={skills}
              loading={loading}
              mode="browse"
              selectedSkillId={selectedSkill?.id ?? null}
              displayNameByName={skillDisplayByName}
              onSkillClick={(skill) => {
                trackUsage({
                  eventName: "skills_panel_select",
                  feature: "skills_scope_panel",
                  action: "select_skill",
                  properties: { skill_name: skill.name },
                });
                const full = skills.find((s) => s.id === skill.id);
                if (full) setSelectedSkill(full);
              }}
            />
          </div>

          <div className="lg:col-span-2">
            {!selectedSkill && (
              <div className="bg-slate-200/60 dark:bg-slate-800/60 border border-slate-300 dark:border-slate-700 rounded-xl p-8 flex flex-col items-center justify-center min-h-64">
                <p className="text-slate-500 text-sm">👈 从左侧选择一个技能查看详情和策略状态</p>
              </div>
            )}

            {selectedSkill && (
              <div className="bg-slate-200/60 dark:bg-slate-800/60 border border-slate-300 dark:border-slate-700 rounded-xl p-6 space-y-5">
                <div className="flex items-start justify-between">
                  <div>
                    <h2 className="text-2xl font-bold">{selectedSkillTitle}</h2>
                    <p className="mt-1 text-xs text-slate-500">技能标识：{selectedSkill.name}</p>
                    <p className="text-slate-400 text-sm mt-1">{selectedSkill.description || "暂无描述"}</p>
                  </div>
                  <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                    selectedSkill.enabled
                      ? "bg-green-500/20 text-green-400"
                      : "bg-orange-500/20 text-orange-400"
                  }`}>
                    {selectedSkill.enabled ? "✓ 启用" : "✗ 禁用"}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div className="bg-slate-300/40 dark:bg-slate-700/40 rounded-lg p-3">
                    <p className="text-xs text-slate-400">版本</p>
                    <p className="font-medium mt-0.5">v{selectedSkill.version}</p>
                  </div>
                  <div className="bg-slate-300/40 dark:bg-slate-700/40 rounded-lg p-3">
                    <p className="text-xs text-slate-400">来源 / 归属</p>
                    <p className="font-medium mt-0.5">
                      {selectedSkill.source}
                      {" · "}
                      {skillScopeLabel(selectedSkill.scope)}
                    </p>
                  </div>
                  <div className="bg-slate-300/40 dark:bg-slate-700/40 rounded-lg p-3">
                    <p className="text-xs text-slate-400">安装时间</p>
                    <p className="font-medium mt-0.5">{new Date(selectedSkill.installed_at).toLocaleString("zh-CN")}</p>
                  </div>
                  <div className="bg-slate-300/40 dark:bg-slate-700/40 rounded-lg p-3">
                    <p className="text-xs text-slate-400">更新时间</p>
                    <p className="font-medium mt-0.5">{new Date(selectedSkill.updated_at).toLocaleString("zh-CN")}</p>
                  </div>
                </div>

                <div>
                  <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">
                    包内文件
                  </h3>
                  <SkillPackageLayoutTags
                    layout={packageLayout}
                    loading={packageLoading}
                    mode="readonly"
                    skillName={selectedSkill.name}
                    manageHref={`/skills/${encodeURIComponent(selectedSkill.name)}`}
                  />
                </div>

                {/* Version History */}
                {selectedSkill.version_history && selectedSkill.version_history.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">版本历史</h3>
                    <div className="space-y-2">
                      {selectedSkill.version_history.map((v, i) => (
                        <div key={i} className="bg-slate-300 dark:bg-slate-700/30 border border-slate-300 dark:border-slate-700 rounded-lg p-3 text-sm">
                          <div className="flex items-center justify-between">
                            <span className="font-medium text-blue-400">v{v.version}</span>
                            <span className="text-xs text-slate-500">{new Date(v.installed_at).toLocaleString("zh-CN")}</span>
                          </div>
                          {v.changelog && <p className="text-slate-400 text-xs mt-1">{v.changelog}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div className="flex items-center gap-3 pt-2 border-t border-slate-300 dark:border-slate-700">
                  <Link
                    href={`/skills/${encodeURIComponent(selectedSkill.name)}`}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition"
                  >
                    包结构与文件
                  </Link>
                  <button
                    onClick={() => handleToggle(selectedSkill)}
                    className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                      selectedSkill.enabled
                        ? "bg-orange-600 hover:bg-orange-500 text-white"
                        : "bg-green-600 hover:bg-green-500 text-white"
                    }`}
                  >
                    {selectedSkill.enabled ? "禁用" : "启用"}
                  </button>
                  <button
                    onClick={() => handleUninstall(selectedSkill.name)}
                    className="px-4 py-2 bg-red-600/20 border border-red-600/40 hover:bg-red-600/30 text-red-400 rounded-lg text-sm font-medium transition"
                  >
                    卸载
                  </button>
                </div>
              </div>
            )}

          </div>
        </div>
      </div>
    </main>
  );
}
