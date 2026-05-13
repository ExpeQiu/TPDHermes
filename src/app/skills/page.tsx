"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";

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

type Tab = "installed" | "marketplace";

const API = "http://localhost:8000/skills";

export default function SkillsPage() {
  const [tab, setTab] = useState<Tab>("installed");
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
      const res = await fetch(API);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
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
      const res = await fetch(`${API}/${skill.name}/enable`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !skill.enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchSkills();
      showMsg(`${skill.name} 已${!skill.enabled ? "启用" : "禁用"}`);
    } catch (e: unknown) {
      showMsg(`操作失败: ${e instanceof Error ? e.message : ""}`);
    }
  };

  const handleUninstall = async (name: string) => {
    if (!confirm(`确定要卸载 Skill「${name}」吗？`)) return;
    try {
      const res = await fetch(`${API}/${name}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
      const res = await fetch(`${API}/${name}/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
    <main className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 text-white p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center gap-3 mb-2">
            <Link href="/" className="text-slate-400 hover:text-white transition text-sm">
              ← 返回首页
            </Link>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold">Skills 管理</h1>
              <p className="text-slate-400 mt-1">管理已安装的 Skills — 配置、版本、启用/禁用</p>
            </div>
            <Link
              href="/skills/market"
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm font-medium transition"
            >
              📦 访问技能市场
            </Link>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4">
            <p className="text-xs text-slate-400 uppercase tracking-wider">已安装</p>
            <p className="text-2xl sm:text-3xl font-bold text-white mt-1">{skills.length}</p>
          </div>
          <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4">
            <p className="text-xs text-slate-400 uppercase tracking-wider">启用中</p>
            <p className="text-2xl sm:text-3xl font-bold text-green-400 mt-1">{installedCount}</p>
          </div>
          <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4">
            <p className="text-xs text-slate-400 uppercase tracking-wider">已禁用</p>
            <p className="text-2xl sm:text-3xl font-bold text-orange-400 mt-1">{disabledCount}</p>
          </div>
        </div>

        {/* Action message */}
        {actionMsg && (
          <div className="mb-4 px-4 py-3 bg-blue-600/20 border border-blue-600/40 rounded-lg text-blue-300 text-sm">
            {actionMsg}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mb-4 px-4 py-3 bg-red-600/20 border border-red-600/40 rounded-lg text-red-300 text-sm">
            ❌ {error}（Skills Store API 尚未启动，或使用本地 mock 数据）
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Skill List */}
          <div className="lg:col-span-1">
            <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4">
              <h2 className="text-lg font-semibold mb-3">已安装的 Skills</h2>
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
                      <p className="text-xs text-slate-400 mt-1">v{skill.version}</p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Detail Panel */}
          <div className="lg:col-span-2">
            {!selectedSkill && (
              <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-8 flex flex-col items-center justify-center min-h-64">
                <p className="text-slate-500 text-sm">👈 从左侧选择一个 Skill 查看详情</p>
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
