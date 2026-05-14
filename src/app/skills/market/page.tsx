"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { apiFetch, apiGet, readJson } from "@/lib/api";

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
const MOCK_MARKET: MarketSkill[] = [
  {
    id: "speech-writer",
    name: "发言稿生成器",
    description: "生成领导讲话、产品发布、技术分享等场景的正式发言稿，支持多种风格定制",
    version: "2.1.0",
    author: "TPDTeam",
    category: "文档",
    icon: "🎤",
    tags: ["发言稿", "领导讲话", "产品发布"],
    install_count: 1284,
    rating: 4.8,
    review_count: 236,
    updated_at: "2026-04-28",
  },
  {
    id: "video-script",
    name: "视频脚本生成器",
    description: "生成短视频/宣传片的分镜脚本，包含旁白、画面描述和时长提示",
    version: "1.5.2",
    author: "TPDTeam",
    category: "文档",
    icon: "🎬",
    tags: ["视频脚本", "宣传片", "短视频"],
    install_count: 876,
    rating: 4.6,
    review_count: 142,
    updated_at: "2026-04-20",
  },
  {
    id: "a4-onepager",
    name: "A4一页纸生成器",
    description: "单页精华文档生成器，提炼核心信息，适合快速阅读和传播分享",
    version: "3.0.1",
    author: "TPDTeam",
    category: "文档",
    icon: "📄",
    tags: ["一页纸", "精华", "摘要"],
    install_count: 2103,
    rating: 4.9,
    review_count: 389,
    updated_at: "2026-05-01",
  },
  {
    id: "tech-article",
    name: "技术文章生成器",
    description: "生成深度技术文章，适合公众号、技术博客发布，包含代码示例",
    version: "2.3.0",
    author: "TPDTeam",
    category: "文档",
    icon: "✍️",
    tags: ["技术文章", "博客", "公众号"],
    install_count: 654,
    rating: 4.5,
    review_count: 98,
    updated_at: "2026-04-15",
  },
  {
    id: "social-copy",
    name: "社交媒体文案助手",
    description: "生成微博、小红书、朋友圈等社交平台的短文案，支持多平台适配",
    version: "1.8.0",
    author: "TPDTeam",
    category: "文案",
    icon: "📱",
    tags: ["社交媒体", "小红书", "微博"],
    install_count: 1567,
    rating: 4.7,
    review_count: 271,
    updated_at: "2026-04-30",
  },
  {
    id: "business-email",
    name: "商务邮件生成器",
    description: "专业商务邮件生成，支持多种场景和语气，自动添加专业格式",
    version: "1.2.3",
    author: "TPDTeam",
    category: "文档",
    icon: "📧",
    tags: ["商务邮件", "邮件", "沟通"],
    install_count: 932,
    rating: 4.4,
    review_count: 167,
    updated_at: "2026-03-28",
  },
  {
    id: "data-analysis",
    name: "数据分析报告器",
    description: "自动分析数据并生成结构化分析报告，支持图表解读和趋势分析",
    version: "1.0.0",
    author: "TPDTeam",
    category: "分析",
    icon: "📊",
    tags: ["数据分析", "报告", "图表"],
    install_count: 423,
    rating: 4.3,
    review_count: 67,
    updated_at: "2026-04-10",
  },
  {
    id: "image-desc",
    name: "图片描述生成器",
    description: "为产品图片、技术架构图等生成精准的文字描述和 alt 文本",
    version: "0.9.1",
    author: "TPDTeam",
    category: "图片",
    icon: "🖼️",
    tags: ["图片描述", "alt", "产品图"],
    install_count: 312,
    rating: 4.2,
    review_count: 45,
    updated_at: "2026-04-05",
  },
  {
    id: "meeting-minutes",
    name: "会议纪要生成器",
    description: "从会议内容自动生成结构化会议纪要，提取决议事项和待办任务",
    version: "2.0.0",
    author: "TPDTeam",
    category: "效率",
    icon: "⚡",
    tags: ["会议纪要", "效率", "协作"],
    install_count: 789,
    rating: 4.6,
    review_count: 134,
    updated_at: "2026-05-02",
  },
  {
    id: "knowledge-graph",
    name: "知识图谱构建器",
    description: "从文档中自动提取实体和关系，构建可视化知识图谱",
    version: "1.1.0",
    author: "TPDTeam",
    category: "知识",
    icon: "🧠",
    tags: ["知识图谱", "知识管理", "NLP"],
    install_count: 541,
    rating: 4.5,
    review_count: 89,
    updated_at: "2026-04-18",
  },
];

function catalogItemToMarket(row: Record<string, unknown>): MarketSkill {
  const pkg = String(row.name ?? "");
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
    updated_at: "2026-01-01",
  };
}

function StarRating({ rating }: { rating: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <span
          key={star}
          className={`text-sm ${
            star <= Math.round(rating) ? "text-yellow-400" : "text-slate-600"
          }`}
        >
          ★
        </span>
      ))}
    </div>
  );
}

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
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
  const [sortBy, setSortBy] = useState<"installs" | "rating" | "updated">("installs");
  const [installing, setInstalling] = useState<string | null>(null);
  const [installedSet, setInstalledSet] = useState<Set<string>>(new Set());
  const [actionMsg, setActionMsg] = useState("");

  const fetchMarket = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const raw = await apiGet<Record<string, unknown>[]>("/skills/marketplace");
      setSkills(raw.map(catalogItemToMarket));
    } catch {
      setSkills(MOCK_MARKET);
      setError("无法连接技能市场 API，已显示演示数据");
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshInstalled = useCallback(async () => {
    try {
      const rows = await apiGet<Array<{ name: string }>>("/skills/");
      setInstalledSet(new Set(rows.map((r) => r.name)));
    } catch {
      setInstalledSet(new Set());
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
      const res = await apiFetch("/skills/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: skill.id,
          description: skill.description || skill.name,
          source: "local",
        }),
      });
      await readJson(res);
      setInstalledSet((prev) => new Set([...prev, skill.id]));
      showMsg(`「${skill.name}」安装成功！`);
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
      if (sortBy === "rating") return b.rating - a.rating;
      if (sortBy === "updated") return b.updated_at.localeCompare(a.updated_at);
      return b.install_count - a.install_count;
    });

  const totalInstalls = skills.reduce((sum, s) => sum + s.install_count, 0);

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 text-white p-4 sm:p-6 md:p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-2">
            <div>
              <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold">技能市场</h1>
              <p className="text-slate-400 text-sm mt-1">发现和安装高质量技能</p>
            </div>
            <Link
              href="/skills"
              className="text-sm text-slate-400 hover:text-white transition self-start"
            >
              ← 已安装技能管理
            </Link>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-4">
            <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-3 sm:p-4">
              <p className="text-xs text-slate-400 uppercase tracking-wider">在架技能</p>
              <p className="text-2xl font-bold mt-1">{skills.length}</p>
            </div>
            <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-3 sm:p-4">
              <p className="text-xs text-slate-400 uppercase tracking-wider">总安装量</p>
              <p className="text-2xl font-bold mt-1 text-blue-400">{formatCount(totalInstalls)}</p>
            </div>
            <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-3 sm:p-4 col-span-2 sm:col-span-1">
              <p className="text-xs text-slate-400 uppercase tracking-wider">我的安装</p>
              <p className="text-2xl font-bold mt-1 text-green-400">{installedSet.size}</p>
            </div>
          </div>
        </div>

        {/* Action message */}
        {actionMsg && (
          <div className="mb-4 px-4 py-3 bg-green-600/20 border border-green-600/40 rounded-lg text-green-300 text-sm">
            ✓ {actionMsg}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="mb-4 px-4 py-3 bg-red-600/20 border border-red-600/40 rounded-lg text-red-300 text-sm">
            ❌ {error}
          </div>
        )}

        {/* Search + Sort */}
        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          <div className="relative flex-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">🔍</span>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索技能名称、描述或标签…"
              className="w-full bg-slate-800/80 border border-slate-700 rounded-lg pl-9 pr-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition"
            />
          </div>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
            className="bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500 transition appearance-none cursor-pointer min-w-36"
          >
            <option value="installs">🔥 最多安装</option>
            <option value="rating">⭐ 最高评分</option>
            <option value="updated">🕐 最近更新</option>
          </select>
        </div>

        {/* Category tabs */}
        <div className="flex gap-2 overflow-x-auto pb-2 mb-6 scrollbar-hide">
          {CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setActiveCategory(cat.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs sm:text-sm font-medium whitespace-nowrap transition ${
                activeCategory === cat.id
                  ? "bg-blue-600 text-white"
                  : "bg-slate-800/80 border border-slate-700 text-slate-400 hover:text-white hover:border-slate-600"
              }`}
            >
              <span>{cat.icon}</span>
              <span>{cat.label}</span>
            </button>
          ))}
        </div>

        {/* Skill Grid */}
        {loading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="bg-slate-800/60 border border-slate-700 rounded-xl p-5 animate-pulse">
                <div className="h-4 bg-slate-700 rounded w-3/4 mb-3" />
                <div className="h-3 bg-slate-700 rounded w-full mb-2" />
                <div className="h-3 bg-slate-700 rounded w-2/3" />
              </div>
            ))}
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="text-center py-16 text-slate-500">
            <p className="text-4xl mb-3">🔍</p>
            <p>没有找到匹配的技能</p>
          </div>
        )}

        {!loading && filtered.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map((skill) => {
              const isInstalled = installedSet.has(skill.id);
              const isInstalling = installing === skill.id;

              return (
                <div
                  key={skill.id}
                  className="bg-slate-800/60 border border-slate-700 rounded-xl p-4 sm:p-5 flex flex-col hover:border-slate-600 hover:bg-slate-800/80 transition group"
                >
                  {/* Card header */}
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <span className="text-3xl">{skill.icon}</span>
                      <div>
                        <h3 className="font-semibold text-sm sm:text-base leading-tight">{skill.name}</h3>
                        <p className="text-slate-500 text-xs mt-0.5">by {skill.author} · v{skill.version}</p>
                      </div>
                    </div>
                    <span className="text-xs bg-slate-700/80 text-slate-400 px-2 py-0.5 rounded-full shrink-0">
                      {skill.category}
                    </span>
                  </div>

                  {/* Description */}
                  <p className="text-slate-400 text-xs sm:text-sm leading-relaxed flex-1 mb-3 line-clamp-2">
                    {skill.description}
                  </p>

                  {/* Tags */}
                  <div className="flex flex-wrap gap-1 mb-3">
                    {skill.tags.slice(0, 3).map((tag) => (
                      <span
                        key={tag}
                        className="text-xs bg-slate-700/60 text-slate-400 px-2 py-0.5 rounded"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>

                  {/* Stats */}
                  <div className="flex items-center justify-between mb-3 pb-3 border-b border-slate-700/60">
                    <div className="flex items-center gap-3">
                      <StarRating rating={skill.rating} />
                      <span className="text-xs text-slate-400">{skill.rating.toFixed(1)}</span>
                    </div>
                    <div className="flex items-center gap-1 text-xs text-slate-500">
                      <span>↓</span>
                      <span>{formatCount(skill.install_count)}</span>
                    </div>
                  </div>

                  {/* Footer */}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-500">更新于 {skill.updated_at}</span>
                    <button
                      onClick={() => !isInstalled && !isInstalling && handleInstall(skill)}
                      disabled={isInstalled || isInstalling}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                        isInstalled
                          ? "bg-green-600/20 text-green-400 cursor-default"
                          : isInstalling
                          ? "bg-slate-700 text-slate-400 cursor-not-allowed"
                          : "bg-blue-600 hover:bg-blue-500 text-white"
                      }`}
                    >
                      {isInstalled ? "✓ 已安装" : isInstalling ? "安装中…" : "安装"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
