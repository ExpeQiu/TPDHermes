"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { apiFetch, apiGet, readJson } from "@/lib/api";
import { CONTENT_MAX_CLASS } from "@/lib/content-shell";

interface MarketSkill {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  category: string;
  icon: string;
  tags: string[];
  install_count: number;
  rating: number;
  review_count: number;
  updated_at: string;
  changelog?: string;
  publisher_id?: string;
  source?: string;
}

interface Category {
  id: string;
  label: string;
  icon: string;
}

const CATEGORIES: Category[] = [
  { id: "all", label: "全部", icon: "🗂️" },
  { id: "文档", label: "文档生成", icon: "📄" },
  { id: "文案", label: "文案创作", icon: "✍️" },
  { id: "分析", label: "数据分析", icon: "📊" },
  { id: "图片", label: "图片处理", icon: "🖼️" },
  { id: "效率", label: "效率工具", icon: "⚡" },
  { id: "知识", label: "知识管理", icon: "🧠" },
];

// Mock marketplace data
function catalogItemToMarket(row: Record<string, unknown>): MarketSkill {
  const pkg = String(row.name ?? "");
  const updatedAtRaw = String(row.updated_at ?? "2026-01-01");
  const updatedAt =
    updatedAtRaw.length >= 10 && updatedAtRaw[4] === "-" && updatedAtRaw[7] === "-"
      ? updatedAtRaw.slice(0, 10)
      : "2026-01-01";
  return {
    id: pkg,
    name: String(row.display_name ?? row.name ?? pkg),
    description: String(row.description ?? ""),
    version: String(row.latest_version ?? "1.0.0"),
    author: String(row.author ?? "TPD Team"),
    category: String(row.category ?? "文档类"),
    icon: String(row.icon ?? "📦"),
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
    install_count: typeof row.installs === "number" ? row.installs : Number(row.installs ?? 0),
    rating: typeof row.rating === "number" ? row.rating : Number(row.rating ?? 0),
    review_count: 0,
    updated_at: updatedAt,
    publisher_id: String(row.publisher_id ?? ""),
    source: String(row.source ?? ""),
  };
}

function sourceTypeLabel(skill: MarketSkill): "工作区" | "用户" {
  return skill.source === "workspace" || !skill.publisher_id ? "工作区" : "用户";
}

function publisherLabel(skill: MarketSkill): string {
  if (skill.publisher_id) return skill.publisher_id;
  return skill.author || "TPD Team";
}

/** Tab 为「文档」「文案」等短名，后端目录为「文档类」「文案类」时仍能筛选 */
function uiCategoryMatchesBackendTab(
  uiTabId: string,
  backendCategory: string,
): boolean {
  if (uiTabId === "all") return true;
  if (backendCategory === uiTabId) return true;
  if (backendCategory === `${uiTabId}类`) return true;
  if (backendCategory.startsWith(uiTabId)) return true;
  return false;
}

export default function SkillMarketPage() {
  const [skills, setSkills] = useState<MarketSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("all");
  const [sortBy, setSortBy] = useState<"name" | "updated">("updated");
  const [installing, setInstalling] = useState<string | null>(null);
  const [installedSet, setInstalledSet] = useState<Set<string>>(new Set());
  const [installedSourceSet, setInstalledSourceSet] = useState<Set<string>>(new Set());
  const [actionMsg, setActionMsg] = useState("");

  const fetchMarket = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const raw = await apiGet<Record<string, unknown>[]>("/skills/marketplace");
      setSkills(raw.map(catalogItemToMarket));
    } catch (e: unknown) {
      setSkills([]);
      setError(e instanceof Error ? e.message : "无法连接技能市场");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshInstalled = useCallback(async () => {
    try {
      const rows = await apiGet<Array<{ name: string; config?: Record<string, unknown> }>>("/skills/");
      const names = new Set<string>();
      const sources = new Set<string>();
      for (const row of rows) {
        names.add(row.name);
        const marketSource = String(row.config?.market_source_name ?? "");
        if (marketSource) sources.add(marketSource);
      }
      setInstalledSet(names);
      setInstalledSourceSet(sources);
    } catch {
      setInstalledSet(new Set());
      setInstalledSourceSet(new Set());
    }
  }, []);

  useEffect(() => {
    fetchMarket();
  }, [fetchMarket]);

  useEffect(() => {
    void refreshInstalled();
  }, [refreshInstalled]);

  const showMsg = (msg: string) => {
    setActionMsg(msg);
    setTimeout(() => setActionMsg(""), 3000);
  };

  const handleInstall = async (skill: MarketSkill) => {
    setInstalling(skill.id);
    try {
      const res = await apiFetch("/skills/marketplace/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: skill.id,
          description: skill.description || skill.name,
        }),
      });
      const installed = await readJson<{ name?: string }>(res);
      const installedName = String(installed?.name ?? skill.id);
      setInstalledSet((prev) => new Set([...prev, installedName]));
      setInstalledSourceSet((prev) => new Set([...prev, skill.id]));
      const renamed = installedName !== skill.id;
      showMsg(renamed ? `「${skill.name}」已安装为「${installedName}」` : `「${skill.name}」安装成功！`);
      await refreshInstalled();
    } catch (e) {
      showMsg(`安装失败：${e instanceof Error ? e.message : "未知错误"}`);
    } finally {
      setInstalling(null);
    }
  };

  const filtered = skills
    .filter((s) => {
      const matchSearch =
        !search ||
        s.name.includes(search) ||
        s.description.includes(search) ||
        s.tags.some((t) => t.includes(search));
      const matchCat =
        activeCategory === "all" ||
        uiCategoryMatchesBackendTab(activeCategory, s.category);
      return matchSearch && matchCat;
    })
    .sort((a, b) => {
      if (sortBy === "name") return a.name.localeCompare(b.name, "zh-CN");
      return b.updated_at.localeCompare(a.updated_at);
    });

  const workspaceCount = skills.filter((skill) => skill.source === "workspace" || !skill.publisher_id).length;

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100 p-4 text-slate-900 sm:p-6 md:p-8 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 dark:text-white">
      <div className={CONTENT_MAX_CLASS}>
        <div className="mb-8">
          <div className="mb-3 flex items-center gap-3">
            <Link href="/skills" className="text-sm text-slate-400 transition hover:text-slate-900 dark:hover:text-white">
              ← 返回技能策略
            </Link>
          </div>
          <div className="inline-flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-200">
            <span className="h-2 w-2 rounded-full bg-blue-400" aria-hidden />
            能力发现入口
          </div>
          <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h1 className="text-3xl font-bold sm:text-4xl">技能市场</h1>
              <p className="mt-2 max-w-2xl text-sm text-slate-400 sm:text-base">
                浏览已登记的公共技能。工作区技能无需再次安装。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link
                href="/skills"
                className="rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900/70 px-4 py-2.5 text-sm font-medium text-slate-800 dark:text-slate-200 transition hover:border-slate-300 dark:border-slate-600 hover:bg-slate-200 dark:hover:bg-slate-900"
              >
                查看技能策略
              </Link>
              <Link
                href="/create"
                className="rounded-xl border border-blue-500/40 bg-blue-500/10 px-4 py-2.5 text-sm font-medium text-blue-200 transition hover:border-blue-400 hover:bg-blue-500/20"
              >
                去场景编排
              </Link>
            </div>
          </div>

          <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <MetricCard label="在架能力" value={String(skills.length)} hint="当前可发现技能" />
            <MetricCard label="已在工作区" value={String(workspaceCount)} hint="随仓库登记，不必再装" />
            <MetricCard label="我的安装" value={String(installedSet.size)} hint="已纳入本地能力池" />
          </div>
        </div>

        {actionMsg && (
          <div className="mb-4 px-4 py-3 bg-green-600/20 border border-green-600/40 rounded-lg text-green-300 text-sm">
            ✓ {actionMsg}
          </div>
        )}

        {error && (
          <div className="mb-4 px-4 py-3 bg-red-600/20 border border-red-600/40 rounded-lg text-red-300 text-sm">
            ❌ {error}
          </div>
        )}

        <section className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/50 p-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">发现技能</p>
              <h2 className="mt-2 text-xl font-semibold text-slate-900 dark:text-white">浏览与安装</h2>
            </div>
          </div>

          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <div className="relative flex-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">🔍</span>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索技能名称、描述或标签…"
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-200/80 dark:bg-slate-800/80 py-2.5 pl-9 pr-4 text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 transition focus:border-blue-500 focus:outline-none"
              />
            </div>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
              className="min-w-36 cursor-pointer appearance-none rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-200/80 dark:bg-slate-800/80 px-3 py-2.5 text-sm text-slate-900 dark:text-white transition focus:border-blue-500 focus:outline-none"
            >
              <option value="updated">最近更新</option>
              <option value="name">名称</option>
            </select>
          </div>

          <div className="mb-0 mt-4 flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                className={`whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium transition sm:text-sm ${
                  activeCategory === cat.id
                    ? "bg-blue-600 text-white"
                    : "border border-slate-300 dark:border-slate-700 bg-slate-200/80 dark:bg-slate-800/80 text-slate-400 hover:border-slate-300 dark:border-slate-600 hover:text-slate-900 dark:hover:text-white"
                }`}
              >
                <span>{cat.icon}</span>
                <span className="ml-1.5">{cat.label}</span>
              </button>
            ))}
          </div>

          <div className="mt-6">
            {loading && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {[...Array(6)].map((_, i) => (
                  <div key={i} className="animate-pulse rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-200/60 dark:bg-slate-800/60 p-5">
                    <div className="mb-3 h-4 w-3/4 rounded bg-slate-300 dark:bg-slate-700" />
                    <div className="mb-2 h-3 w-full rounded bg-slate-300 dark:bg-slate-700" />
                    <div className="h-3 w-2/3 rounded bg-slate-300 dark:bg-slate-700" />
                  </div>
                ))}
              </div>
            )}

            {!loading && filtered.length === 0 && (
              <div className="py-16 text-center text-slate-500">
                <p className="mb-3 text-4xl">🔍</p>
                <p>没有找到匹配的技能</p>
              </div>
            )}

            {!loading && filtered.length > 0 && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {filtered.map((skill) => {
                  const isInstalled = installedSet.has(skill.id) || installedSourceSet.has(skill.id);
                  const inWorkspace = skill.source === "workspace" || isInstalled;
                  const isInstalling = installing === skill.id;

                  return (
                    <div
                      key={skill.id}
                      className="group flex flex-col rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-200/60 dark:bg-slate-800/60 p-4 transition hover:border-slate-300 dark:border-slate-600 hover:bg-slate-200/80 dark:bg-slate-800/80 sm:p-5"
                    >
                      <div className="mb-3 flex items-start justify-between">
                        <div className="flex items-center gap-3">
                          <span className="text-3xl">{skill.icon}</span>
                          <div>
                            <h3 className="text-sm font-semibold leading-tight sm:text-base">{skill.name}</h3>
                            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                              <span>发布者 {publisherLabel(skill)}</span>
                              <span>·</span>
                              <span>v{skill.version}</span>
                              <span
                                className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                                  sourceTypeLabel(skill) === "用户"
                                    ? "bg-blue-500/20 text-blue-300"
                                    : "bg-emerald-500/20 text-emerald-300"
                                }`}
                              >
                                {sourceTypeLabel(skill)}
                              </span>
                            </div>
                          </div>
                        </div>
                        <span className="shrink-0 rounded-full bg-slate-300 dark:bg-slate-700/80 px-2 py-0.5 text-xs text-slate-400">
                          {skill.category}
                        </span>
                      </div>

                      <p className="mb-3 flex-1 line-clamp-2 text-xs leading-relaxed text-slate-400 sm:text-sm">
                        {skill.description}
                      </p>

                      <div className="mb-3 flex flex-wrap gap-1">
                        {skill.tags.slice(0, 3).map((tag) => (
                          <span
                            key={tag}
                            className="rounded bg-slate-300/60 dark:bg-slate-700/60 px-2 py-0.5 text-xs text-slate-400"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>

                      <div className="flex items-center justify-between gap-3 border-t border-slate-300 pt-3 dark:border-slate-700/60">
                        <span className="text-xs text-slate-500">更新于 {skill.updated_at}</span>
                        <button
                          onClick={() => !inWorkspace && !isInstalling && handleInstall(skill)}
                          disabled={inWorkspace || isInstalling}
                          className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                            inWorkspace
                              ? "cursor-default bg-green-600/20 text-green-400"
                              : isInstalling
                                ? "cursor-not-allowed bg-slate-300 dark:bg-slate-700 text-slate-400"
                                : "bg-blue-600 text-white hover:bg-blue-500"
                          }`}
                        >
                          {inWorkspace ? "已在工作区" : isInstalling ? "安装中…" : "安装"}
                        </button>
                      </div>

                      {isInstalled && (
                        <div className="mt-3 rounded-lg border border-green-600/30 bg-green-600/10 px-3 py-2 text-xs text-green-300">
                          已在工作区，可直接在技能工坊试跑或绑定到场景。
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

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
    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/50 p-4">
      <p className="text-xs uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-3 text-2xl font-semibold text-slate-900 dark:text-white">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{hint}</p>
    </div>
  );
}
