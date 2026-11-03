"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import { apiFetch, readJson } from "@/lib/api";
import { CONTENT_MAX_CLASS } from "@/lib/content-shell";
import { SkillPackageLayoutTags } from "@/components/skills/SkillPackageLayoutTags";
import { SkillsScopePanel } from "@/components/skills/SkillsScopePanel";
import { skillLabel, skillScopeLabel } from "@/lib/ui-labels";
import { trackUsage } from "@/lib/usage-tracker";
import { useEffectiveUserScopeId } from "@/lib/use-effective-user-scope-id";

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
  when?: string;
  triggers?: string[];
  input_schema?: Record<string, string>;
  market_category?: string;
};

type SkillUsageRow = {
  skill_name: string;
  call_count: number;
  adoption_rate: number | null;
  full_count: number;
  partial_count: number;
  reject_count: number;
  bound_scenarios?: string[];
  viewer_adopted?: number;
};

type SkillUsageView = {
  skills_total_calls: number;
  skills_overall_adoption_rate: number | null;
  skill_usage: SkillUsageRow[];
};

type SkillTrialResult = {
  status: string;
  content?: string | null;
  error?: string | null;
  missing_fields?: string[];
  suggested_collection?: string | null;
  fallback_reason?: string | null;
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
  const scopeUserId = useEffectiveUserScopeId();
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
  const [usage, setUsage] = useState<SkillUsageView | null>(null);
  const [trialFields, setTrialFields] = useState<Record<string, string>>({});
  const [trialCollection, setTrialCollection] = useState("");
  const [trialBusy, setTrialBusy] = useState(false);
  const [trialResult, setTrialResult] = useState<SkillTrialResult | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const fetchSkills = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [skillsRes, metaRes, usageRes] = await Promise.allSettled([
        apiFetch(SKILLS_BASE).then((res) => readJson<Skill[]>(res)),
        apiFetch("/ws/skills/metadata").then((res) =>
          readJson<{ skills: SkillMetaRow[] }>(res),
        ),
        apiFetch("/skills/usage?days=7").then((res) => readJson<SkillUsageView>(res)),
      ]);
      if (skillsRes.status === "fulfilled") {
        setSkills(skillsRes.value);
      } else {
        throw skillsRes.reason;
      }
      if (metaRes.status === "fulfilled") {
        setSkillMeta(metaRes.value.skills ?? []);
      }
      if (usageRes.status === "fulfilled") {
        setUsage(usageRes.value);
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
      eventName: "skills_view",
      feature: "skills",
      action: "view",
    });
  }, []);

  const metaByName = useMemo(
    () => new Map(skillMeta.map((row) => [row.name, row])),
    [skillMeta],
  );
  const usageByName = useMemo(
    () => new Map((usage?.skill_usage ?? []).map((row) => [row.skill_name, row])),
    [usage],
  );

  const skillDisplayByName = useMemo(
    () =>
      new Map(
        skillMeta
          .map((m) => [m.name, m.display_name?.trim() ?? ""] as const)
          .filter(([, displayName]) => displayName.length > 0),
      ),
    [skillMeta],
  );

  const detailByName = useMemo(() => {
    const lines = new Map<string, string>();
    for (const skill of skills) {
      const meta = metaByName.get(skill.name);
      const used = usageByName.get(skill.name);
      const when = meta?.when?.trim() || (meta?.triggers ?? []).slice(0, 3).join(" / ");
      const required = Object.keys(meta?.input_schema ?? {}).slice(0, 4).join("、");
      const recent = used && used.call_count > 0 ? `近 7 日 ${used.call_count} 次` : "近 7 日未运行";
      lines.set(
        skill.name,
        [when, required ? `必填 ${required}` : "", recent].filter(Boolean).join(" · "),
      );
    }
    return lines;
  }, [skills, metaByName, usageByName]);

  const selectedMeta = selectedSkill ? metaByName.get(selectedSkill.name) : undefined;
  const selectedUsage = selectedSkill ? usageByName.get(selectedSkill.name) : undefined;
  const selectedSchema = selectedMeta?.input_schema ?? {};

  useEffect(() => {
    setTrialFields({});
    setTrialCollection("");
    setTrialResult(null);
  }, [selectedSkill?.name]);

  const handleTrial = async () => {
    if (!selectedSkill) return;
    setTrialBusy(true);
    setTrialResult(null);
    try {
      const res = await apiFetch(`${SKILLS_BASE}${encodeURIComponent(selectedSkill.name)}/trial`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fields: trialFields,
          collection_name: trialCollection.trim(),
        }),
      });
      const data = await readJson<SkillTrialResult>(res);
      setTrialResult(data);
      console.info("[skills]", {
        event: "skill.trial",
        skill_name: selectedSkill.name,
        status: data.status,
        missing: data.missing_fields ?? [],
      });
    } catch (e: unknown) {
      setTrialResult({
        status: "failed",
        error: e instanceof Error ? e.message : "试跑失败",
      });
    } finally {
      setTrialBusy(false);
    }
  };

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

  const handlePublishGlobal = async (skill: Skill) => {
    const owner = (skill.owner_id || "").trim();
    if (!owner) {
      showMsg(`「${skill.name}」已经是公共技能`);
      return;
    }
    if (!confirm(`确认将「${skill.name}」发布为全员可见吗？`)) return;
    trackUsage({
      eventName: "skills_publish_global_click",
      feature: "skills",
      action: "publish_global_click",
      properties: { skill_name: skill.name, owner_from: owner },
    });
    try {
      const res = await apiFetch(`${SKILLS_BASE}${skill.name}/publish-global`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publish: true }),
      });
      await readJson(res);
      await fetchSkills();
      showMsg(`「${skill.name}」已发布全员`);
    } catch (e: unknown) {
      showMsg(`发布失败: ${e instanceof Error ? e.message : ""}`);
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

  const callCount = usage?.skills_total_calls ?? 0;
  const adoptionRate = usage?.skills_overall_adoption_rate;
  const adoptionLabel =
    adoptionRate == null ? "—" : `${Math.round(adoptionRate * 100)}%`;
  const isDefaultAdmin = scopeUserId === "default";

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100 p-4 text-slate-900 sm:p-6 md:p-8 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 dark:text-white">
      <div className={CONTENT_MAX_CLASS}>
        <div className="mb-8">
          <div className="mb-3 flex items-center justify-between gap-4">
            <Link href="/" className="text-sm text-slate-400 transition hover:text-slate-900 dark:hover:text-white">
              ← 返回首页
            </Link>
            <div className="inline-flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-200">
              <span className="h-2 w-2 rounded-full bg-amber-400" aria-hidden />
              交付目录
            </div>
          </div>
          <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h1 className="text-3xl font-bold sm:text-4xl">技能工坊</h1>
              <p className="mt-2 max-w-2xl text-sm text-slate-400 sm:text-base">
                工作区内容包登记后即可试跑。场景白名单里的技能会在对话里出稿；采纳与退回记在近 7 日用量上。
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

        <div className="mb-6 grid grid-cols-1 gap-3 md:grid-cols-3">
          <MetricCard label="已登记" value={String(skills.length)} hint="工作区与已上传技能" />
          <MetricCard label="近 7 日成稿" value={String(callCount)} hint="对话与工坊中命中技能的次数" />
          <MetricCard label="有反馈的采纳率" value={adoptionLabel} hint="无反馈时显示 —" />
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
              detailByName={detailByName}
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

                <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                  <div className="rounded-lg bg-slate-300/40 p-3 dark:bg-slate-700/40">
                    <p className="text-xs text-slate-400">适用说法</p>
                    <p className="mt-0.5">{selectedMeta?.when || "未声明"}</p>
                  </div>
                  <div className="rounded-lg bg-slate-300/40 p-3 dark:bg-slate-700/40">
                    <p className="text-xs text-slate-400">适用场景</p>
                    <p className="mt-0.5">{selectedMeta?.market_category || "未标注"}</p>
                  </div>
                  <div className="rounded-lg bg-slate-300/40 p-3 dark:bg-slate-700/40">
                    <p className="text-xs text-slate-400">场景白名单</p>
                    <p className="mt-0.5">
                      {(selectedUsage?.bound_scenarios ?? []).length
                        ? selectedUsage?.bound_scenarios?.join("、")
                        : "尚未绑定"}
                    </p>
                  </div>
                  <div className="rounded-lg bg-slate-300/40 p-3 dark:bg-slate-700/40">
                    <p className="text-xs text-slate-400">采纳 / 退回</p>
                    <p className="mt-0.5">
                      采纳 {selectedUsage?.viewer_adopted ?? 0} 次 · 退回 {selectedUsage?.reject_count ?? 0} 次
                    </p>
                  </div>
                </div>

                <div>
                  <h3 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-300">试跑</h3>
                  <p className="mb-3 text-xs text-slate-500">
                    必填输入：{Object.keys(selectedSchema).join("、") || "该技能未声明 input_schema"}
                  </p>
                  <div className="space-y-2">
                    {Object.keys(selectedSchema).map((key) => (
                      <label key={key} className="block text-xs text-slate-400">
                        {key}
                        <span className="ml-2 text-slate-500">{selectedSchema[key]}</span>
                        <textarea
                          value={trialFields[key] ?? ""}
                          onChange={(ev) =>
                            setTrialFields((prev) => ({ ...prev, [key]: ev.target.value }))
                          }
                          rows={2}
                          className="mt-1 w-full rounded-lg border border-slate-300 bg-white/80 px-3 py-2 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-900/80 dark:text-slate-100"
                        />
                      </label>
                    ))}
                    <label className="block text-xs text-slate-400">
                      知识库集合
                      <input
                        value={trialCollection}
                        onChange={(ev) => setTrialCollection(ev.target.value)}
                        placeholder="缺证据时建议填写集合名"
                        className="mt-1 w-full rounded-lg border border-slate-300 bg-white/80 px-3 py-2 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-900/80 dark:text-slate-100"
                      />
                    </label>
                    <button
                      type="button"
                      disabled={trialBusy || !selectedSkill.enabled}
                      onClick={() => void handleTrial()}
                      className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                    >
                      {trialBusy ? "生成中…" : "试跑"}
                    </button>
                  </div>
                  {trialResult ? (
                    <div className="mt-3 rounded-lg border border-slate-300 p-3 text-sm dark:border-slate-600">
                      <p className="text-xs text-slate-500">状态 {trialResult.status}</p>
                      {trialResult.missing_fields && trialResult.missing_fields.length > 0 ? (
                        <p className="mt-2 text-amber-700 dark:text-amber-300">
                          缺少字段：{trialResult.missing_fields.join("、")}
                          {trialResult.suggested_collection
                            ? `。建议补充：${trialResult.suggested_collection}`
                            : ""}
                        </p>
                      ) : null}
                      {trialResult.error ? <p className="mt-2 text-red-400">{trialResult.error}</p> : null}
                      {trialResult.content ? (
                        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs text-slate-700 dark:text-slate-200">
                          {trialResult.content}
                        </pre>
                      ) : null}
                    </div>
                  ) : null}
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
                  {isDefaultAdmin && (selectedSkill.owner_id || "").trim() ? (
                    <button
                      onClick={() => handlePublishGlobal(selectedSkill)}
                      className="px-4 py-2 bg-emerald-600/20 border border-emerald-600/40 hover:bg-emerald-600/30 text-emerald-300 rounded-lg text-sm font-medium transition"
                    >
                      发布全员
                    </button>
                  ) : null}
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
