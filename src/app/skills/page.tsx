"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { apiFetch, readJson } from "@/lib/api";

interface Skill {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  source: string;
  config: Record<string, unknown>;
  version_history: Array<{ version: string; changelog: string; installed_at: string }>;
  installed_at: string;
  updated_at: string;
}

const SKILLS_BASE = "/skills/";

function MetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
      <p className="text-xs uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-3 text-2xl font-semibold text-white">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{hint}</p>
    </div>
  );
}

function StrategyCard({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
      <p className="text-base font-medium text-white">{title}</p>
      <p className="mt-2 text-sm leading-relaxed text-slate-400">{desc}</p>
    </div>
  );
}

export default function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [editingConfig, setEditingConfig] = useState(false);
  const [configText, setConfigText] = useState("");
  const [actionMsg, setActionMsg] = useState("");

  const fetchSkills = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await apiFetch(SKILLS_BASE);
      const data = await readJson<Skill[]>(res);
      setSkills(data);
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

  const showMsg = (msg: string) => {
    setActionMsg(msg);
    setTimeout(() => setActionMsg(""), 3000);
  };

  const handleToggle = async (skill: Skill) => {
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
    if (!confirm(`确定要卸载 Skill「${name}」吗？`)) return;
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

  const handleSaveConfig = async (name: string) => {
    try {
      const config = JSON.parse(configText);
      const res = await apiFetch(`${SKILLS_BASE}${name}/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      await readJson(res);
      setEditingConfig(false);
      await fetchSkills();
      showMsg("配置已保存");
    } catch (e: unknown) {
      showMsg(`配置格式错误: ${e instanceof Error ? e.message : ""}`);
    }
  };

  const openConfigEditor = (skill: Skill) => {
    setSelectedSkill(skill);
    setConfigText(JSON.stringify(skill.config || {}, null, 2));
    setEditingConfig(true);
  };

  const installedCount = skills.filter((s) => s.enabled).length;
  const disabledCount = skills.length - installedCount;

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-4 text-white sm:p-6 md:p-8">
      <div className="mx-auto max-w-6xl">
        <div className="mb-8">
          <div className="mb-3 flex items-center gap-3">
            <Link href="/" className="text-sm text-slate-400 transition hover:text-white">
              ← 返回首页
            </Link>
          </div>
          <div className="inline-flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-200">
            <span className="h-2 w-2 rounded-full bg-amber-400" aria-hidden />
            技能策略入口
          </div>
          <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h1 className="text-3xl font-bold sm:text-4xl">技能策略与已安装能力</h1>
              <p className="mt-3 max-w-3xl text-sm leading-relaxed text-slate-400 sm:text-base">
                技能页现在不仅管理安装状态，也承担技能策略入口角色。这里决定哪些能力可被任务编排使用、偏好哪些能力、哪些能力应保持禁用。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link
                href="/skills/market"
                className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium transition hover:bg-blue-500"
              >
                访问技能市场
              </Link>
              <Link
                href="/create"
                className="rounded-xl border border-slate-700 bg-slate-900/70 px-4 py-2.5 text-sm font-medium text-slate-200 transition hover:border-slate-600 hover:bg-slate-900"
              >
                去场景编排
              </Link>
            </div>
          </div>
        </div>

        <div className="mb-6 grid grid-cols-1 gap-3 md:grid-cols-4">
          <MetricCard label="已安装" value={String(skills.length)} hint="当前本地能力池" />
          <MetricCard label="启用中" value={String(installedCount)} hint="可参与任务执行" />
          <MetricCard label="已禁用" value={String(disabledCount)} hint="保留但不主动使用" />
          <MetricCard label="策略目标" value="白名单 / 偏好 / 禁用" hint="后续对接编排策略" />
        </div>

        <div className="mb-6 grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
          <div className="rounded-3xl border border-slate-800 bg-slate-900/50 p-6">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Skill Policy</p>
            <h2 className="mt-2 text-xl font-semibold text-white">技能策略说明</h2>
            <div className="mt-5 grid gap-3 md:grid-cols-3">
              <StrategyCard
                title="启用中"
                desc="适合作为默认候选技能，被项目或场景编排引用。"
              />
              <StrategyCard
                title="已禁用"
                desc="保留安装状态，但不让任务执行链路主动使用。"
              />
              <StrategyCard
                title="市场安装"
                desc="通过技能市场扩充能力池，再回到本页进行启用和配置。"
              />
            </div>
          </div>

          <div className="rounded-3xl border border-slate-800 bg-slate-900/50 p-6">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Recommended Path</p>
            <h2 className="mt-2 text-xl font-semibold text-white">推荐路径</h2>
            <div className="mt-5 space-y-3 text-sm leading-relaxed text-slate-400">
              <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                <p className="font-medium text-white">1. 浏览市场</p>
                <p className="mt-1">先从技能市场补齐缺少的能力，再决定是否安装。</p>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                <p className="font-medium text-white">2. 配置与启用</p>
                <p className="mt-1">在本页调整配置、启用状态和版本，形成稳定能力池。</p>
              </div>
              <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
                <p className="font-medium text-white">3. 回到任务入口</p>
                <p className="mt-1">最终让技能策略在场景编排、对话协作和结果工坊中生效。</p>
              </div>
            </div>
          </div>
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
            <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4">
              <h2 className="text-lg font-semibold mb-3">已安装技能池</h2>
              {loading && <p className="text-slate-400 text-sm text-center py-6">加载中…</p>}
              {!loading && skills.length === 0 && (
                <p className="text-slate-500 text-sm text-center py-6">暂无已安装的 Skills</p>
              )}
              {!loading && skills.length > 0 && (
                <div className="space-y-2">
                  {skills.map((skill) => (
                    <button
                      key={skill.id}
                      onClick={() => { setSelectedSkill(skill); setEditingConfig(false); }}
                      className={`w-full text-left p-3 rounded-lg border transition ${
                        selectedSkill?.id === skill.id
                          ? "bg-blue-600/20 border-blue-500"
                          : "bg-slate-700/40 border-slate-600 hover:border-slate-500"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">{skill.name}</span>
                        <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                          skill.enabled
                            ? "bg-green-500/20 text-green-400"
                            : "bg-orange-500/20 text-orange-400"
                        }`}>
                          {skill.enabled ? "启用" : "禁用"}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-400">v{skill.version}</p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="lg:col-span-2">
            {!selectedSkill && (
              <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-8 flex flex-col items-center justify-center min-h-64">
                <p className="text-slate-500 text-sm">👈 从左侧选择一个 Skill 查看详情和策略状态</p>
              </div>
            )}

            {selectedSkill && !editingConfig && (
              <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-6 space-y-5">
                <div className="flex items-start justify-between">
                  <div>
                    <h2 className="text-2xl font-bold">{selectedSkill.name}</h2>
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
                  <div className="bg-slate-700/40 rounded-lg p-3">
                    <p className="text-xs text-slate-400">版本</p>
                    <p className="font-medium mt-0.5">v{selectedSkill.version}</p>
                  </div>
                  <div className="bg-slate-700/40 rounded-lg p-3">
                    <p className="text-xs text-slate-400">来源</p>
                    <p className="font-medium mt-0.5">{selectedSkill.source}</p>
                  </div>
                  <div className="bg-slate-700/40 rounded-lg p-3">
                    <p className="text-xs text-slate-400">安装时间</p>
                    <p className="font-medium mt-0.5">{new Date(selectedSkill.installed_at).toLocaleString("zh-CN")}</p>
                  </div>
                  <div className="bg-slate-700/40 rounded-lg p-3">
                    <p className="text-xs text-slate-400">更新时间</p>
                    <p className="font-medium mt-0.5">{new Date(selectedSkill.updated_at).toLocaleString("zh-CN")}</p>
                  </div>
                </div>

                {/* Config */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-semibold text-slate-300">当前配置</h3>
                    <button
                      onClick={() => openConfigEditor(selectedSkill)}
                      className="text-xs px-3 py-1 bg-slate-700 hover:bg-slate-600 rounded-lg transition"
                    >
                      编辑配置
                    </button>
                  </div>
                  <pre className="bg-slate-900/60 border border-slate-700 rounded-lg p-3 text-xs text-slate-300 overflow-auto max-h-32">
                    {JSON.stringify(selectedSkill.config || {}, null, 2)}
                  </pre>
                </div>

                {/* Version History */}
                {selectedSkill.version_history && selectedSkill.version_history.length > 0 && (
                  <div>
                    <h3 className="text-sm font-semibold text-slate-300 mb-2">版本历史</h3>
                    <div className="space-y-2">
                      {selectedSkill.version_history.map((v, i) => (
                        <div key={i} className="bg-slate-700/30 border border-slate-700 rounded-lg p-3 text-sm">
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
                <div className="flex items-center gap-3 pt-2 border-t border-slate-700">
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

            {/* Config Editor */}
            {selectedSkill && editingConfig && (
              <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-xl font-semibold">编辑配置 — {selectedSkill.name}</h2>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setEditingConfig(false)}
                      className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded-lg text-sm transition"
                    >
                      取消
                    </button>
                    <button
                      onClick={() => handleSaveConfig(selectedSkill.name)}
                      className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium transition"
                    >
                      保存配置
                    </button>
                  </div>
                </div>
                <p className="text-xs text-slate-400">以 JSON 格式编辑 Skill 配置</p>
                <textarea
                  value={configText}
                  onChange={(e) => setConfigText(e.target.value)}
                  className="w-full h-48 bg-slate-900 border border-slate-700 rounded-lg p-4 text-sm text-slate-200 font-mono resize-none focus:outline-none focus:border-blue-500"
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
