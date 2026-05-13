"use client";

import { useState, useCallback } from "react";
import KBDegradedBanner from "@/components/kb/KBDegradedBanner";
import Link from "next/link";

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

interface SearchResult {
  entries: KBEntry[];
  total: number;
  query: string;
}

// ============== Mock 数据（backend 实现前使用） ==============
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

// ============== API 封装 ==============
const API_BASE = "/api/kb";

async function fetchCollections(): Promise<Collection[]> {
  const res = await fetch(`${API_BASE}/collections`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function searchKB(
  query: string,
  topK: number = 10
): Promise<KBEntry[]> {
  const res = await fetch(
    `${API_BASE}/collections/default/query?q=${encodeURIComponent(query)}&top_k=${topK}`
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.entries ?? [];
}

async function fetchEntry(id: string): Promise<KBEntry> {
  const res = await fetch(`${API_BASE}/entries/${id}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ============== 工具函数 ==============
function formatDate(dateStr: string): string {
  return dateStr || "未知";
}

// ============== 主页面组件 ==============
export default function KnowledgePage() {
  const [activeTab, setActiveTab] = useState<"browse" | "search">("browse");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<KBEntry[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState<KBEntry | null>(null);
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 10;

  // 切换 Tab 时重置状态
  const handleTabChange = (tab: "browse" | "search") => {
    setActiveTab(tab);
    setSelectedEntry(null);
    setPage(0);
    if (tab === "search") {
      setSearchResults([]);
      setSearchQuery("");
    }
  };

  // 执行搜索（带 Mock fallback）
  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    setPage(0);
    try {
      const results = await searchKB(searchQuery.trim(), PAGE_SIZE);
      setSearchResults(results);
    } catch {
      // Mock fallback：模糊匹配 title
      const q = searchQuery.toLowerCase();
      const filtered = MOCK_ENTRIES.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          e.summary.toLowerCase().includes(q)
      );
      setSearchResults(filtered);
    } finally {
      setIsSearching(false);
    }
  }, [searchQuery]);

  // 点击条目查看详情
  const handleEntryClick = async (entry: KBEntry) => {
    if (selectedEntry?.id === entry.id) {
      setSelectedEntry(null);
      return;
    }
    try {
      const detail = await fetchEntry(entry.id);
      setSelectedEntry(detail);
    } catch {
      // Mock fallback：直接使用列表数据
      setSelectedEntry(entry);
    }
  };

  // 渲染列表视图
  const renderBrowseView = () => {
    const collections = MOCK_COLLECTIONS; // TODO: 替换为真实 API
    return (
      <div>
        {/* Collection 标签栏 */}
        <div className="flex gap-2 mb-6 flex-wrap">
          {collections.map((col) => (
            <button
              key={col.name}
              onClick={() => setActiveTab("browse")}
              className="px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm hover:bg-slate-700 hover:border-slate-600 transition"
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
          {MOCK_ENTRIES.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(
            (entry) => (
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
                  {entry.projects.length > 0 && (
                    <>
                      <span>·</span>
                      <span>关联 {entry.projects.length} 个项目</span>
                    </>
                  )}
                </div>
              </div>
            )
          )}
        </div>

        {/* 分页 */}
        {MOCK_ENTRIES.length > PAGE_SIZE && (
          <div className="flex justify-center gap-3 mt-6">
            <button
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
              onClick={() =>
                setPage((p) =>
                  (p + 1) * PAGE_SIZE < MOCK_ENTRIES.length ? p + 1 : p
                )
              }
              disabled={(page + 1) * PAGE_SIZE >= MOCK_ENTRIES.length}
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
    <main className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 text-white p-8">
      <div className="max-w-5xl mx-auto">
        {/* 页面标题 */}
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-4xl font-bold">知识库</h1>
        </div>

        {/* Tab 切换 */}
        <div className="flex gap-1 mb-6 bg-slate-800/60 p-1 rounded-lg border border-slate-700 w-fit">
          <button
            onClick={() => handleTabChange("browse")}
            className={`px-5 py-2 rounded-md text-sm font-medium transition ${
              activeTab === "browse"
                ? "bg-blue-600 text-white"
                : "text-slate-400 hover:text-white"
            }`}
          >
            浏览
          </button>
          <button
            onClick={() => handleTabChange("search")}
            className={`px-5 py-2 rounded-md text-sm font-medium transition ${
              activeTab === "search"
                ? "bg-blue-600 text-white"
                : "text-slate-400 hover:text-white"
            }`}
          >
            搜索
          </button>
        </div>

        {/* 主内容区 */}
        <div>
          {activeTab === "browse" ? renderBrowseView() : renderSearchView()}
        </div>

        {/* 详情面板 */}
        {selectedEntry && renderDetailPanel(selectedEntry)}
      </div>
    </main>
  );
}
