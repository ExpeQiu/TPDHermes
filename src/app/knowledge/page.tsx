"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import KBDegradedBanner from "@/components/kb/KBDegradedBanner";
import Link from "next/link";
import { apiGet, getPublicApiBase } from "@/lib/api";
import { CONTENT_MAX_CLASS } from "@/lib/content-shell";

// ============== 类型定义 ==============
interface KBEntry {
  id: string;
  title: string;
  source: string;
  summary: string;
  collection: string;
  created_at: string;
  projects: number[]; // 关联项目 ID 列表
}

interface Collection {
  name: string;
  description: string;
  entry_count: number;
}

interface ProjectLite {
  id: string;
  name: string;
}

const USE_MOCK_KB = process.env.NEXT_PUBLIC_USE_MOCK_KB === "true";

// ============== Mock 数据（仅当 NEXT_PUBLIC_USE_MOCK_KB=true 时作为 fallback） ==============
const MOCK_COLLECTIONS: Collection[] = [
  { name: "meeting_notes", description: "会议纪要", entry_count: 42 },
  { name: "tech_docs", description: "技术文档", entry_count: 28 },
  { name: "product_specs", description: "产品规格", entry_count: 15 },
  { name: "user_feedback", description: "用户反馈", entry_count: 63 },
];

const MOCK_ENTRIES: KBEntry[] = [
  {
    id: "ent_001",
    title: "2026-Q1 战略规划会议纪要",
    source: "飞书文档",
    summary: "讨论了公司 Q1 战略方向，重点包括 AI 能力集成、海外市场拓展以及组织架构调整。会后明确了三个核心 OKR。",
    collection: "meeting_notes",
    created_at: "2026-01-15",
    projects: [1, 3],
  },
  {
    id: "ent_002",
    title: "知识库架构设计文档",
    source: "内部 Wiki",
    summary: "描述了知识库系统的整体架构，包括向量存储、检索流程、缓存策略以及与项目系统的关联机制。",
    collection: "tech_docs",
    created_at: "2026-02-20",
    projects: [2],
  },
  {
    id: "ent_003",
    title: "TPDHermes 产品需求规格",
    source: "飞书表格",
    summary: "TPDHermes 项目的完整需求文档，涵盖项目管理系统、知识库、外部化服务三大模块的功能定义。",
    collection: "product_specs",
    created_at: "2026-03-01",
    projects: [4],
  },
  {
    id: "ent_004",
    title: "用户访谈：研发效能反馈",
    source: "用户访谈记录",
    summary: "收集了 12 位研发人员对当前项目协作工具的反馈，主要痛点在于信息分散、检索困难、关联不清晰。",
    collection: "user_feedback",
    created_at: "2026-03-18",
    projects: [1, 2, 4],
  },
  {
    id: "ent_005",
    title: "向量检索技术选型报告",
    source: "内部报告",
    summary: "对比了 Milvus、Qdrant、Chroma 三个向量数据库的优劣势，最终推荐 Qdrant 作为知识库检索引擎。",
    collection: "tech_docs",
    created_at: "2026-04-05",
    projects: [2],
  },
];

function mapCacheRow(row: Record<string, unknown>): KBEntry {
  const meta = (row.metadata as Record<string, unknown>) || {};
  const title =
    (typeof meta.title === "string" && meta.title) ||
    String(row.content ?? "").slice(0, 80) ||
    "未命名条目";
  const projectsRaw = meta.projects ?? meta.project_ids;
  const projects = Array.isArray(projectsRaw)
    ? (projectsRaw as unknown[]).map((x) => Number(x)).filter((n) => !Number.isNaN(n))
    : [];
  return {
    id: String(row.id ?? ""),
    title,
    source: String(row.source ?? meta.source ?? "缓存"),
    summary: String(row.content ?? "").slice(0, 280),
    collection: String(row.collection ?? ""),
    created_at: String(row.created_at ?? row.updated_at ?? ""),
    projects,
  };
}

function mapQueryResult(
  r: { content?: string; metadata?: Record<string, unknown> },
  i: number,
  collection: string,
): KBEntry {
  const meta = r.metadata || {};
  const title =
    (typeof meta.title === "string" && meta.title) ||
    (r.content || "").slice(0, 80) ||
    `结果 ${i + 1}`;
  return {
    id: String(meta.id ?? `hit_${i}`),
    title,
    source: String(meta.source ?? "知识库"),
    summary: (r.content || "").slice(0, 280),
    collection,
    created_at: String(meta.created_at ?? ""),
    projects: [],
  };
}

// ============== 主页面组件 ==============
function formatDate(dateStr: string): string {
  return dateStr || "未知";
}

export default function KnowledgePage() {
  const [activeTab, setActiveTab] = useState<"browse" | "search">("browse");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<KBEntry[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState<KBEntry | null>(null);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 10;

  const [collections, setCollections] = useState<Collection[]>([]);
  const [browseEntries, setBrowseEntries] = useState<KBEntry[]>([]);
  const [kbLoadError, setKbLoadError] = useState<string | null>(null);
  const [filterCollection, setFilterCollection] = useState<string | null>(null);
  const [lastSseMessage, setLastSseMessage] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const sseRef = useRef<EventSource | null>(null);

  const reloadKbBrowse = useCallback(async () => {
    if (USE_MOCK_KB) {
      setCollections(MOCK_COLLECTIONS);
      setBrowseEntries(MOCK_ENTRIES);
      setKbLoadError(null);
      return;
    }
    try {
      setKbLoadError(null);
      const colRes = await apiGet<{ collections: string[]; warning?: string }>(
        "/kb/collections",
      );
      const cols: Collection[] = colRes.collections.map((name) => ({
        name,
        description: name,
        entry_count: 0,
      }));
      const entRes = await apiGet<{ entries: Record<string, unknown>[] }>(
        "/kb/cache/entries/__all__?limit=100",
      );
      const entries = entRes.entries.map((row) => mapCacheRow(row));
      const counts = new Map<string, number>();
      for (const e of entries) {
        counts.set(e.collection, (counts.get(e.collection) ?? 0) + 1);
      }
      setCollections(
        cols.map((c) => ({
          ...c,
          entry_count: counts.get(c.name) ?? 0,
        })),
      );
      setBrowseEntries(entries);
    } catch (e) {
      if (USE_MOCK_KB) {
        setCollections(MOCK_COLLECTIONS);
        setBrowseEntries(MOCK_ENTRIES);
        setKbLoadError(null);
        return;
      }
      setKbLoadError(e instanceof Error ? e.message : "加载失败");
      setCollections([]);
      setBrowseEntries([]);
    }
  }, []);

  useEffect(() => {
    void reloadKbBrowse();
  }, [reloadKbBrowse]);

  useEffect(() => {
    apiGet<ProjectLite[]>("/projects/")
      .then((rows) => setProjects(rows))
      .catch(() => setProjects([]));
  }, []);

  useEffect(() => {
    if (USE_MOCK_KB || typeof window === "undefined") return;
    const url = `${getPublicApiBase()}/api/v1/kb/events`;
    const es = new EventSource(url);
    sseRef.current = es;
    es.onmessage = (ev) => {
      try {
        const o = JSON.parse(ev.data) as { type?: string; event_type?: string };
        const t = o.type ?? o.event_type;
        if (
          t === "sync_complete" ||
          t === "entry_added" ||
          t === "entry_updated" ||
          t === "query_fallback"
        ) {
          setLastSseMessage(`知识库事件：${t}`);
          void reloadKbBrowse();
        }
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => {
      es.close();
    };
    return () => {
      es.close();
      sseRef.current = null;
    };
  }, [reloadKbBrowse]);

  const handleTabChange = (tab: "browse" | "search") => {
    setActiveTab(tab);
    setSelectedEntry(null);
    setPage(0);
    if (tab === "search") {
      setSearchResults([]);
      setSearchQuery("");
    }
  };

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    setPage(0);
    const q = searchQuery.trim();
    const collectionName =
      collections[0]?.name ||
      browseEntries[0]?.collection ||
      "default";
    try {
      if (USE_MOCK_KB) {
        const filtered = MOCK_ENTRIES.filter(
          (e) =>
            e.title.toLowerCase().includes(q.toLowerCase()) ||
            e.summary.toLowerCase().includes(q.toLowerCase()),
        );
        setSearchResults(filtered);
        return;
      }
      const data = await apiGet<{
        results: Array<{ content?: string; metadata?: Record<string, unknown> }>;
      }>(
        `/kb/collections/${encodeURIComponent(collectionName)}/query?q=${encodeURIComponent(q)}&n=${PAGE_SIZE}`,
      );
      setSearchResults(
        data.results.map((r, i) => mapQueryResult(r, i, collectionName)),
      );
    } catch {
      if (USE_MOCK_KB) {
        const filtered = MOCK_ENTRIES.filter(
          (e) =>
            e.title.toLowerCase().includes(q.toLowerCase()) ||
            e.summary.toLowerCase().includes(q.toLowerCase()),
        );
        setSearchResults(filtered);
      } else {
        setSearchResults([]);
        setKbLoadError("搜索请求失败");
      }
    } finally {
      setIsSearching(false);
    }
  }, [searchQuery, collections, browseEntries]);

  const handleEntryClick = async (entry: KBEntry) => {
    if (selectedEntry?.id === entry.id) {
      setSelectedEntry(null);
      return;
    }
    setSelectedEntry(entry);
  };

  const visibleBrowseEntries = browseEntries.filter(
    (e) => !filterCollection || e.collection === filterCollection,
  );
  const projectBoundCount = browseEntries.filter((entry) => entry.projects.length > 0).length;
  const collectionCount = collections.length > 0 ? collections.length : MOCK_COLLECTIONS.length;
  const browseCount = browseEntries.length;
  const boundProjectIds = new Set(browseEntries.flatMap((entry) => entry.projects));

  // 渲染列表视图
  const renderBrowseView = () => {
    const cols = collections.length > 0 ? collections : MOCK_COLLECTIONS;
    const rows =
      visibleBrowseEntries.length > 0 ? visibleBrowseEntries : USE_MOCK_KB ? MOCK_ENTRIES : [];
    return (
      <div>
        {lastSseMessage && (
          <p className="text-xs text-slate-500 mb-3">{lastSseMessage}</p>
        )}
        {kbLoadError && (
          <p className="text-sm text-amber-400 mb-3">
            知识库数据加载异常：{kbLoadError}
            {USE_MOCK_KB ? "" : "（可设置 NEXT_PUBLIC_USE_MOCK_KB=true 启用演示数据）"}
          </p>
        )}
        {/* Collection 标签栏 */}
        <div className="flex gap-2 mb-6 flex-wrap">
          <button
            type="button"
            onClick={() => setFilterCollection(null)}
            className={`px-4 py-2 rounded-lg text-sm border transition ${
              filterCollection === null
                ? "bg-blue-600 border-blue-500 text-white"
                : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700"
            }`}
          >
            全部
          </button>
          {cols.map((col) => (
            <button
              type="button"
              key={col.name}
              onClick={() =>
                setFilterCollection((prev) =>
                  prev === col.name ? null : col.name,
                )
              }
              className={`px-4 py-2 rounded-lg text-sm border transition ${
                filterCollection === col.name
                  ? "bg-blue-600 border-blue-500 text-white"
                  : "bg-slate-800 border-slate-700 hover:bg-slate-700"
              }`}
            >
              <span className="text-white font-medium">{col.description}</span>
              <span className="ml-2 text-slate-400 text-xs">
                ({col.entry_count})
              </span>
            </button>
          ))}
        </div>

        {/* 条目列表 */}
        <div className="space-y-3">
          {rows.length === 0 && (
            <p className="text-slate-500 text-center py-8 text-sm">
              暂无条目。可在外部 KB 同步后刷新，或切换到「搜索」尝试实时查询。
            </p>
          )}
          {rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((entry) => (
            <div
              key={entry.id}
              onClick={() => void handleEntryClick(entry)}
              className={`bg-slate-800/60 border rounded-xl p-5 cursor-pointer transition ${
                selectedEntry?.id === entry.id
                  ? "border-blue-500 bg-slate-700/60"
                  : "border-slate-700 hover:bg-slate-700/40 hover:border-slate-600"
              }`}
            >
              <div className="flex items-start justify-between mb-2">
                <h3 className="text-lg font-semibold text-white">
                  {entry.title}
                </h3>
                <span className="text-xs text-slate-500 bg-slate-700 px-2 py-1 rounded">
                  {entry.collection}
                </span>
              </div>
              <p className="text-slate-400 text-sm mb-3 line-clamp-2">
                {entry.summary}
              </p>
              <div className="flex items-center gap-4 text-xs text-slate-500">
                <span>来源：{entry.source}</span>
                <span>·</span>
                <span>{formatDate(entry.created_at)}</span>
                {entry.projects.length > 0 && (
                  <>
                    <span>·</span>
                    <span>关联 {entry.projects.length} 个项目</span>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* 分页 */}
        {rows.length > PAGE_SIZE && (
          <div className="flex justify-center gap-3 mt-6">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              上一页
            </button>
            <span className="px-4 py-2 text-slate-400 text-sm">
              第 {page + 1} 页
            </span>
            <button
              type="button"
              onClick={() =>
                setPage((p) =>
                  (p + 1) * PAGE_SIZE < rows.length ? p + 1 : p,
                )
              }
              disabled={(page + 1) * PAGE_SIZE >= rows.length}
              className="px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              下一页
            </button>
          </div>
        )}
      </div>
    );
  };

  // 渲染搜索结果视图
  const renderSearchView = () => (
    <div>
      {/* 搜索框 */}
      <div className="flex gap-3 mb-6">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          placeholder="输入关键词搜索知识库..."
          className="flex-1 px-4 py-3 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition"
        />
        <button
          onClick={handleSearch}
          disabled={isSearching || !searchQuery.trim()}
          className="px-6 py-3 bg-blue-600 rounded-lg hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition text-white font-medium"
        >
          {isSearching ? "搜索中..." : "搜索"}
        </button>
      </div>

      {/* 搜索结果 */}
      {isSearching ? (
        <p className="text-slate-400 text-center py-12">搜索中...</p>
      ) : searchResults.length === 0 && searchQuery !== "" ? (
        <p className="text-slate-400 text-center py-12">
          未找到与「{searchQuery}」相关的条目
        </p>
      ) : (
        <div className="space-y-3">
          {searchResults.map((entry) => (
            <div
              key={entry.id}
              onClick={() => handleEntryClick(entry)}
              className={`bg-slate-800/60 border rounded-xl p-5 cursor-pointer transition ${
                selectedEntry?.id === entry.id
                  ? "border-blue-500 bg-slate-700/60"
                  : "border-slate-700 hover:bg-slate-700/40 hover:border-slate-600"
              }`}
            >
              <div className="flex items-start justify-between mb-2">
                <h3 className="text-lg font-semibold text-white">
                  {entry.title}
                </h3>
                <span className="text-xs text-slate-500 bg-slate-700 px-2 py-1 rounded">
                  {entry.collection}
                </span>
              </div>
              <p className="text-slate-400 text-sm mb-3 line-clamp-2">
                {entry.summary}
              </p>
              <div className="flex items-center gap-4 text-xs text-slate-500">
                <span>来源：{entry.source}</span>
                <span>·</span>
                <span>{formatDate(entry.created_at)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  // 渲染详情面板
  const renderDetailPanel = (entry: KBEntry) => (
    <div className="bg-slate-800/60 border border-blue-500 rounded-xl p-6 mt-4">
      <div className="flex items-start justify-between mb-4">
        <h3 className="text-xl font-bold text-white">{entry.title}</h3>
        <button
          onClick={() => setSelectedEntry(null)}
          className="text-slate-400 hover:text-white text-xl leading-none"
        >
          ×
        </button>
      </div>

      <div className="space-y-4">
        <div>
          <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">
            来源
          </p>
          <p className="text-slate-300">{entry.source}</p>
        </div>

        <div>
          <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">
            摘要
          </p>
          <p className="text-slate-300 text-sm leading-relaxed">
            {entry.summary}
          </p>
        </div>

        <div>
          <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">
            Collection
          </p>
          <p className="text-slate-300">{entry.collection}</p>
        </div>

        <div>
          <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">
            创建时间
          </p>
          <p className="text-slate-300">{formatDate(entry.created_at)}</p>
        </div>

        {entry.projects.length > 0 && (
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide mb-2">
              关联项目
            </p>
            <div className="flex gap-2 flex-wrap">
              {entry.projects.map((pid) => (
                <Link
                  key={pid}
                  href={`/projects/${pid}`}
                  onClick={(e) => e.stopPropagation()}
                  className="px-3 py-1.5 bg-blue-600/20 border border-blue-500/40 rounded-lg text-blue-300 text-sm hover:bg-blue-600/30 transition"
                >
                  项目 #{pid}
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 p-4 text-white sm:p-6 md:p-8">
      <div className={CONTENT_MAX_CLASS}>
        <header className="mb-8">
          <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-200">
            <span className="h-2 w-2 rounded-full bg-emerald-400" aria-hidden />
            知识策略入口
          </div>
          <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h1 className="text-3xl font-bold sm:text-4xl">知识范围与检索</h1>
              <p className="mt-2 max-w-2xl text-sm text-slate-400 sm:text-base">
                面向<strong className="text-slate-200">公共知识库</strong>
                的浏览与检索验证；条目可被对话创作与场景输出引用，与具体项目的附件/输出解耦。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link
                href="/projects"
                className="rounded-xl border border-slate-700 bg-slate-900/70 px-4 py-2.5 text-sm font-medium text-slate-200 transition hover:border-slate-600 hover:bg-slate-900"
              >
                查看项目中心
              </Link>
              <a
                href="#kb-workspace"
                className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-2.5 text-sm font-medium text-emerald-200 transition hover:border-emerald-400 hover:bg-emerald-500/20"
              >
                知识库工作区
              </a>
            </div>
          </div>
        </header>

        <section className="mb-6 grid gap-3 md:grid-cols-4">
          <MetricCard label="知识集合" value={String(collectionCount)} hint="可作为知识范围" />
          <MetricCard label="缓存条目" value={String(browseCount)} hint="当前浏览基线" />
          <MetricCard label="已绑定项目" value={String(boundProjectIds.size)} hint="出现过项目关联" />
          <MetricCard
            label="项目入口"
            value={String(projects.length)}
            hint={projectBoundCount > 0 ? `${projectBoundCount} 条已有项目关联` : "建议逐步按项目收口"}
          />
        </section>

        <KBDegradedBanner />

        <section id="kb-workspace" className="rounded-3xl border border-slate-800 bg-slate-900/50 p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Knowledge Workspace</p>
              <h2 className="mt-2 text-xl font-semibold text-white">集合浏览与检索验证</h2>
            </div>
            <div className="flex gap-1 rounded-lg border border-slate-700 bg-slate-800/60 p-1">
              <button
                onClick={() => handleTabChange("browse")}
                className={`rounded-md px-5 py-2 text-sm font-medium transition ${
                  activeTab === "browse"
                    ? "bg-blue-600 text-white"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                浏览集合
              </button>
              <button
                onClick={() => handleTabChange("search")}
                className={`rounded-md px-5 py-2 text-sm font-medium transition ${
                  activeTab === "search"
                    ? "bg-blue-600 text-white"
                    : "text-slate-400 hover:text-white"
                }`}
              >
                检索验证
              </button>
            </div>
          </div>

          <div className="mt-6">
            {activeTab === "browse" ? renderBrowseView() : renderSearchView()}
          </div>
        </section>

        {selectedEntry && renderDetailPanel(selectedEntry)}
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
    <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
      <p className="text-xs uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-3 text-2xl font-semibold text-white">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{hint}</p>
    </div>
  );
}
