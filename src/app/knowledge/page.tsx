"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import KBDegradedBanner from "@/components/kb/KBDegradedBanner";
import Link from "next/link";
import { apiDelete, apiFetch, apiGet, apiPost, getPublicApiBase } from "@/lib/api";
import { CONTENT_MAX_CLASS } from "@/lib/content-shell";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// ============== 类型 ==============
interface KBEntry {
  id: string;
  title: string;
  source: string;
  summary: string;
  /** 完整正文（来自缓存 content） */
  body?: string;
  collection: string;
  domain?: string;
  folder_path?: string;
  published?: boolean;
  linked_kg_ids?: string[];
  created_at: string;
  projects: number[];
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

interface BrowseDoc {
  id: string;
  project_id: string;
  collection: string;
  title: string;
  folder_path?: string;
  domain?: string;
  tags?: string[];
  published?: boolean;
  linked_kg_ids?: string[];
  source_url?: string;
  source?: string;
  updated_at?: string;
  summary?: string;
}

interface TreeNode {
  domain?: string;
  segment: string;
  path: string;
  document_count: number;
  total_documents?: number;
  documents: BrowseDoc[];
  children: TreeNode[];
}

interface KgLinkRow {
  id: string;
  kb_entry_id: string;
  kb_project_id: string;
  kg_kind: string;
  kg_node_id: string;
  created_at?: string;
}

const USE_MOCK_KB = process.env.NEXT_PUBLIC_USE_MOCK_KB === "true";

const MOCK_COLLECTIONS: Collection[] = [
  { name: "meeting_notes", description: "会议纪要", entry_count: 42 },
  { name: "tech_docs", description: "技术文档", entry_count: 28 },
];

const MOCK_ENTRIES: KBEntry[] = [
  {
    id: "ent_001",
    title: "示例：目录树需 metadata",
    source: "演示",
    summary: "为启用左侧目录，请在 Chroma metadata 中填写 domain 与 folder_path。",
    body:
      "为启用左侧目录，请在 Chroma metadata 中填写 domain 与 folder_path。\n\n详见 guide/产品1.2升级方案.md 中的 metadata 约定。",
    collection: "tech_docs",
    domain: "structured_tech",
    folder_path: "02-知识库/示例分类",
    created_at: "2026-01-15",
    projects: [],
    published: true,
  },
];

const KB_BROWSE_LIMIT = 3000;

const KG_KINDS = [
  "Brand",
  "Vehicle",
  "TechInsight",
  "CoreTech",
  "PlannedVehicle",
] as const;

/** Chroma 写入时序列化成的 JSON 数组字符串恢复为数组（兼容旧缓存） */
function coerceJsonArrayUnknown(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("[")) {
      try {
        const j = JSON.parse(s) as unknown;
        return Array.isArray(j) ? j : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function mapCacheRow(row: Record<string, unknown>): KBEntry {
  const meta = (row.metadata as Record<string, unknown>) || {};
  const title =
    (typeof meta.title === "string" && meta.title) ||
    String(row.content ?? "").slice(0, 80) ||
    "未命名条目";
  const projArr = coerceJsonArrayUnknown(meta.projects ?? meta.project_ids);
  const projects = projArr
    ? projArr.map((x) => Number(x)).filter((n) => !Number.isNaN(n))
    : [];
  const domain = typeof meta.domain === "string" ? meta.domain : undefined;
  const folder_path =
    typeof meta.folder_path === "string" ? meta.folder_path : undefined;
  const lkArr = coerceJsonArrayUnknown(meta.linked_kg_ids);
  let linked_kg_ids: string[] | undefined;
  if (lkArr) {
    linked_kg_ids = lkArr.map(String);
  } else if (Array.isArray(meta.linked_kg_ids)) {
    linked_kg_ids = (meta.linked_kg_ids as unknown[]).map(String);
  }
  let published: boolean | undefined;
  if (typeof meta.published === "boolean") {
    published = meta.published;
  } else if (typeof meta.published === "string") {
    published = ["1", "true", "yes", "on"].includes(meta.published.toLowerCase());
  }
  return {
    id: String(row.id ?? ""),
    title,
    source: String(row.source ?? meta.source ?? "缓存"),
    summary: String(row.content ?? "").slice(0, 280),
    body: String(row.content ?? ""),
    collection: String(row.collection ?? ""),
    created_at: String(row.created_at ?? row.updated_at ?? ""),
    projects,
    domain,
    folder_path,
    linked_kg_ids,
    published,
  };
}

function mapQueryResult(
  r: { content?: string; metadata?: Record<string, unknown> },
  i: number,
  collectionCtx: string,
): KBEntry {
  const meta = r.metadata || {};
  const title =
    (typeof meta.title === "string" && meta.title) ||
    (r.content || "").slice(0, 80) ||
    `结果 ${i + 1}`;
  const folder_path =
    typeof meta.folder_path === "string" ? meta.folder_path : undefined;
  const domain = typeof meta.domain === "string" ? meta.domain : undefined;
  const projArrQ = coerceJsonArrayUnknown(meta.projects ?? meta.project_ids);
  const projects = projArrQ
    ? projArrQ.map((x) => Number(x)).filter((n) => !Number.isNaN(n))
    : [];
  const lkArrQ = coerceJsonArrayUnknown(meta.linked_kg_ids);
  let linked_kg_ids: string[] | undefined;
  if (lkArrQ) {
    linked_kg_ids = lkArrQ.map(String);
  } else if (Array.isArray(meta.linked_kg_ids)) {
    linked_kg_ids = (meta.linked_kg_ids as unknown[]).map(String);
  }
  return {
    id: String(meta.id ?? `hit_${i}`),
    title,
    source: String(meta.source ?? "知识库"),
    summary: (r.content || "").slice(0, 280),
    body: r.content || "",
    collection:
      typeof meta.collection === "string" ? meta.collection : collectionCtx,
    created_at: String(meta.created_at ?? ""),
    projects,
    domain,
    folder_path,
    linked_kg_ids,
  };
}

function formatDate(dateStr: string): string {
  return dateStr || "未知";
}

function collectDocsFromTree(node: TreeNode): BrowseDoc[] {
  const out = [...(node.documents || [])];
  for (const ch of node.children || []) {
    out.push(...collectDocsFromTree(ch));
  }
  return out;
}

// ============== 树节点组件 ==============
function TreeNav({
  nodes,
  depth,
  selectedPath,
  onSelect,
}: {
  nodes: TreeNode[];
  depth: number;
  selectedPath: string;
  onSelect: (path: string, node: TreeNode) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    depth === 0 ? Object.fromEntries(nodes.map((n) => [n.path || n.segment, true])) : {},
  );

  return (
    <ul className={depth === 0 ? "space-y-0.5" : "mt-0.5 space-y-0.5 border-l border-slate-700 pl-2 ml-1"}>
      {nodes.map((n) => {
        const key = n.path || `${depth}:${n.segment}`;
        const label = n.segment || "(本域根)";
        const isSelected = selectedPath === (n.path || key);
        const hasKids = (n.children?.length ?? 0) > 0;
        const expanded = open[key] ?? depth < 1;

        return (
          <li key={key}>
            <div className="flex items-center gap-1">
              {hasKids ? (
                <button
                  type="button"
                  className="text-slate-500 w-5 text-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen((o) => ({ ...o, [key]: !expanded }));
                  }}
                  aria-label={expanded ? "折叠" : "展开"}
                >
                  {expanded ? "▾" : "▸"}
                </button>
              ) : (
                <span className="w-5" />
              )}
              <button
                type="button"
                onClick={() => onSelect(n.path || key, n)}
                className={`flex-1 text-left rounded px-2 py-1 text-sm ${
                  isSelected
                    ? "bg-blue-600/30 text-white"
                    : "text-slate-300 hover:bg-slate-800"
                }`}
              >
                {label}
                <span className="ml-1 text-xs text-slate-500">
                  ({n.document_count ?? n.total_documents ?? 0})
                </span>
              </button>
            </div>
            {hasKids && expanded ? (
              <TreeNav
                nodes={n.children}
                depth={depth + 1}
                selectedPath={selectedPath}
                onSelect={onSelect}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

// ============== 页面 ==============
export default function KnowledgePage() {
  const [workspaceMode, setWorkspaceMode] = useState<
    "tree" | "collections" | "search" | "graph" | "ingest"
  >("tree");

  const [searchScopeCollection, setSearchScopeCollection] = useState<string>("");

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

  const [browseTree, setBrowseTree] = useState<TreeNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [treeMeta, setTreeMeta] = useState<{
    truncated: boolean;
    entry_count_scanned: number;
  } | null>(null);
  const [selectedTreePath, setSelectedTreePath] = useState("");
  const [selectedTreeNode, setSelectedTreeNode] = useState<TreeNode | null>(null);
  const [treeDocs, setTreeDocs] = useState<BrowseDoc[]>([]);

  const [kgLinks, setKgLinks] = useState<KgLinkRow[]>([]);
  const [kgLinkKind, setKgLinkKind] = useState<string>("CoreTech");
  const [kgLinkNodeId, setKgLinkNodeId] = useState("");
  const [previewMode, setPreviewMode] = useState<"summary" | "markdown">("markdown");

  const [ingestCollection, setIngestCollection] = useState("");
  const [ingestDomain, setIngestDomain] = useState("structured_tech");
  const [ingestFolderPath, setIngestFolderPath] = useState("02-知识库/导入");
  const [ingestProjectId, setIngestProjectId] = useState("__all__");
  const [ingestUploadIds, setIngestUploadIds] = useState<string[]>([]);
  const [ingestBusy, setIngestBusy] = useState(false);
  const [ingestMessage, setIngestMessage] = useState<string | null>(null);
  const [ingestJobId, setIngestJobId] = useState<string | null>(null);
  const [ingestJobView, setIngestJobView] = useState<Record<string, unknown> | null>(null);
  const [ingestDocIdOnUpload, setIngestDocIdOnUpload] = useState("");
  const [ingestUploadDocIdsJson, setIngestUploadDocIdsJson] = useState("");
  const [ingestDocIdStrategy, setIngestDocIdStrategy] = useState<"filename" | "checksum">(
    "filename",
  );

  const [kgStats, setKgStats] = useState<Record<string, unknown> | null>(null);
  const [kgValidate, setKgValidate] = useState<{
    ok: boolean;
    errors: string[];
  } | null>(null);
  const [kgNodes, setKgNodes] = useState<Record<string, unknown>[]>([]);
  const [kgKindPick, setKgKindPick] = useState<string>("Brand");
  const [kgImportText, setKgImportText] = useState("");
  const [kgBusy, setKgBusy] = useState(false);
  const [kgRelations, setKgRelations] = useState<Record<string, unknown>[]>([]);
  const [relForm, setRelForm] = useState({
    rel_type: "HAS_INSIGHT",
    src_kind: "Vehicle",
    src_id: "",
    dst_kind: "TechInsight",
    dst_id: "",
  });

  const entryById = useMemo(() => {
    const m = new Map<string, KBEntry>();
    for (const e of browseEntries) {
      m.set(e.id, e);
    }
    return m;
  }, [browseEntries]);

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
        `/kb/cache/entries/__all__?limit=${KB_BROWSE_LIMIT}`,
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

  const reloadBrowseTree = useCallback(async () => {
    if (USE_MOCK_KB) {
      setBrowseTree([
        {
          segment: "",
          path: "",
          domain: "structured_tech",
          document_count: MOCK_ENTRIES.length,
          total_documents: MOCK_ENTRIES.length,
          documents: MOCK_ENTRIES.map((e) => ({
            id: e.id,
            project_id: "demo",
            collection: e.collection,
            title: e.title,
            folder_path: e.folder_path,
            domain: e.domain,
            published: e.published,
            linked_kg_ids: e.linked_kg_ids,
            summary: e.summary,
          })),
          children: [],
        },
      ]);
      setTreeMeta({
        truncated: false,
        entry_count_scanned: MOCK_ENTRIES.length,
      });
      return;
    }
    setTreeLoading(true);
    setTreeError(null);
    try {
      const data = await apiGet<{
        domains: TreeNode[];
        truncated: boolean;
        entry_count_scanned: number;
      }>("/kb/browse-tree?project_id=__all__&limit=3000");
      setBrowseTree(data.domains || []);
      setTreeMeta({
        truncated: !!data.truncated,
        entry_count_scanned: data.entry_count_scanned ?? 0,
      });
    } catch (e) {
      setTreeError(e instanceof Error ? e.message : "目录树加载失败");
      setBrowseTree([]);
    } finally {
      setTreeLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadKbBrowse();
  }, [reloadKbBrowse]);

  useEffect(() => {
    if (workspaceMode === "tree") {
      void reloadBrowseTree();
    }
  }, [workspaceMode, reloadBrowseTree]);

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
          void reloadBrowseTree();
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
  }, [reloadKbBrowse, reloadBrowseTree]);

  const onTreeSelect = useCallback((path: string, node: TreeNode) => {
    setSelectedTreePath(path);
    setSelectedTreeNode(node);
    setTreeDocs(collectDocsFromTree(node));
    setSelectedEntry(null);
  }, []);

  useEffect(() => {
    if (browseTree.length > 0 && !selectedTreePath) {
      const first = browseTree[0];
      if (first) {
        const p = first.domain || first.path || "root";
        onTreeSelect(p, first);
      }
    }
  }, [browseTree, selectedTreePath, onTreeSelect]);

  const loadKgLinks = useCallback(async (entryId: string, projectId: string | null) => {
    if (!entryId || USE_MOCK_KB) {
      setKgLinks([]);
      return;
    }
    try {
      let path = `/kb/kg-links?kb_entry_id=${encodeURIComponent(entryId)}`;
      if (projectId) {
        path += `&kb_project_id=${encodeURIComponent(projectId)}`;
      }
      const r = await apiGet<{ items: KgLinkRow[] }>(path);
      setKgLinks(r.items || []);
    } catch {
      setKgLinks([]);
    }
  }, []);

  useEffect(() => {
    if (!selectedEntry) {
      setKgLinks([]);
      return;
    }
    const match = entryById.get(selectedEntry.id) ?? selectedEntry;
    const pid =
      match.projects[0] != null ? String(match.projects[0]) : null;
    void loadKgLinks(selectedEntry.id, pid);
  }, [selectedEntry, entryById, loadKgLinks]);

  const handleWorkspaceMode = (m: typeof workspaceMode) => {
    setWorkspaceMode(m);
    setSelectedEntry(null);
    setPage(0);
    if (m === "search") {
      setSearchResults([]);
      setSearchQuery("");
      setSearchScopeCollection("");
    }
  };

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    setPage(0);
    const q = searchQuery.trim();
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
      let url = `/kb/query-all?q=${encodeURIComponent(q)}&n=${PAGE_SIZE}`;
      if (searchScopeCollection) {
        url += `&collection=${encodeURIComponent(searchScopeCollection)}`;
      }
      const data = await apiGet<{
        results: Array<{ content?: string; metadata?: Record<string, unknown> }>;
      }>(url);
      setSearchResults(
        data.results.map((r, i) =>
          mapQueryResult(
            r,
            i,
            (r.metadata?.collection as string) || searchScopeCollection || "_merged",
          ),
        ),
      );
    } catch {
      if (USE_MOCK_KB) {
        setSearchResults(
          MOCK_ENTRIES.filter(
            (e) =>
              e.title.toLowerCase().includes(q.toLowerCase()) ||
              e.summary.toLowerCase().includes(q.toLowerCase()),
          ),
        );
      } else {
        setSearchResults([]);
        setKbLoadError("搜索请求失败");
      }
    } finally {
      setIsSearching(false);
    }
  }, [searchQuery, searchScopeCollection]);

  const handleEntryClick = (entry: KBEntry) => {
    if (selectedEntry?.id === entry.id) {
      setSelectedEntry(null);
      return;
    }
    setSelectedEntry(entry);
  };

  const visibleBrowseEntries = browseEntries.filter(
    (e) => !filterCollection || e.collection === filterCollection,
  );
  const projectBoundCount = browseEntries.filter(
    (entry) => entry.projects.length > 0,
  ).length;
  const collectionCount =
    collections.length > 0 ? collections.length : MOCK_COLLECTIONS.length;
  const browseCount = browseEntries.length;
  const boundProjectIds = new Set(browseEntries.flatMap((entry) => entry.projects));

  const addKgLink = async () => {
    if (!selectedEntry || !kgLinkNodeId.trim() || USE_MOCK_KB) return;
    const fromEntry = entryById.get(selectedEntry.id) ?? selectedEntry;
    const projectId =
      fromEntry.projects[0] != null ? String(fromEntry.projects[0]) : "__all__";
    try {
      await apiPost("/kb/kg-links", {
        kb_entry_id: selectedEntry.id,
        kb_project_id: projectId,
        kg_kind: kgLinkKind,
        kg_node_id: kgLinkNodeId.trim(),
      });
      setKgLinkNodeId("");
      const reloadPid =
        fromEntry.projects[0] != null ? String(fromEntry.projects[0]) : null;
      await loadKgLinks(selectedEntry.id, reloadPid);
    } catch {
      /* ignore */
    }
  };

  const removeKgLink = async (linkId: string) => {
    if (!selectedEntry || USE_MOCK_KB) return;
    const fromEntry = entryById.get(selectedEntry.id) ?? selectedEntry;
    try {
      await apiDelete(`/kb/kg-links/${encodeURIComponent(linkId)}`);
      const reloadPid =
        fromEntry.projects[0] != null ? String(fromEntry.projects[0]) : null;
      await loadKgLinks(selectedEntry.id, reloadPid);
    } catch {
      /* ignore */
    }
  };

  const loadKgPanel = async () => {
    setKgBusy(true);
    try {
      const stats = await apiGet<Record<string, unknown>>("/kg/stats");
      setKgStats(stats);
    } catch {
      setKgStats(null);
    } finally {
      setKgBusy(false);
    }
  };

  const runKgValidate = async () => {
    setKgBusy(true);
    try {
      const v = await apiGet<{ ok: boolean; errors: string[] }>("/kg/validate");
      setKgValidate(v);
    } catch {
      setKgValidate({ ok: false, errors: ["请求失败"] });
    } finally {
      setKgBusy(false);
    }
  };

  const loadKgNodes = async () => {
    setKgBusy(true);
    try {
      const r = await apiGet<{ items: Record<string, unknown>[] }>(
        `/kg/nodes/${encodeURIComponent(kgKindPick)}?limit=200`,
      );
      setKgNodes(r.items || []);
    } catch {
      setKgNodes([]);
    } finally {
      setKgBusy(false);
    }
  };

  const loadKgRels = async () => {
    setKgBusy(true);
    try {
      const r = await apiGet<{ items: Record<string, unknown>[] }>(
        "/kg/relations?limit=200",
      );
      setKgRelations(r.items || []);
    } catch {
      setKgRelations([]);
    } finally {
      setKgBusy(false);
    }
  };

  useEffect(() => {
    if (workspaceMode === "graph" && !USE_MOCK_KB) {
      void loadKgPanel();
    }
  }, [workspaceMode]);

  const doKgImport = async () => {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(kgImportText || "{}") as Record<string, unknown>;
    } catch {
      return;
    }
    setKgBusy(true);
    try {
      await apiPost("/kg/import", body);
      await loadKgPanel();
      await runKgValidate();
    } finally {
      setKgBusy(false);
    }
  };

  const doKgExport = async () => {
    setKgBusy(true);
    try {
      const data = await apiGet<Record<string, unknown>>("/kg/export");
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "kg_export.json";
      a.click();
    } finally {
      setKgBusy(false);
    }
  };

  const addRelation = async () => {
    setKgBusy(true);
    try {
      await apiPost("/kg/relations", relForm);
      await loadKgRels();
      await loadKgPanel();
    } catch {
      /* ignore */
    } finally {
      setKgBusy(false);
    }
  };

  const fullContent = (entry: KBEntry) => {
    const raw = browseEntries.find((e) => e.id === entry.id);
    return raw?.body ?? entry.body ?? raw?.summary ?? entry.summary ?? "";
  };

  const openTreeDocument = async (d: BrowseDoc) => {
    const existing = entryById.get(d.id);
    if (existing) {
      handleEntryClick({ ...existing, title: d.title || existing.title });
      return;
    }
    if (USE_MOCK_KB) return;
    try {
      const row = await apiGet<Record<string, unknown>>(
        `/kb/cache/entry/${encodeURIComponent(d.id)}`,
      );
      const mapped = mapCacheRow(row as Record<string, unknown>);
      setBrowseEntries((prev) =>
        prev.some((e) => e.id === mapped.id) ? prev : [...prev, mapped],
      );
      handleEntryClick({ ...mapped, title: d.title || mapped.title });
    } catch {
      /* ignore */
    }
  };

  const renderTreeWorkspace = () => (
    <div className="grid gap-4 lg:grid-cols-12 min-h-[480px]">
      <div className="lg:col-span-3 rounded-xl border border-slate-700 bg-slate-800/40 p-3 overflow-auto max-h-[70vh]">
        <p className="text-xs text-slate-500 mb-2">域 / 路径</p>
        {treeLoading ? (
          <p className="text-slate-400 text-sm">加载目录树…</p>
        ) : treeError ? (
          <p className="text-amber-400 text-sm">{treeError}</p>
        ) : browseTree.length === 0 ? (
          <p className="text-slate-500 text-sm">
            无树数据。请为条目 metadata 填写 domain 与 folder_path，或先看「按集合」。
          </p>
        ) : (
          <TreeNav
            nodes={browseTree}
            depth={0}
            selectedPath={selectedTreePath}
            onSelect={onTreeSelect}
          />
        )}
        {treeMeta?.truncated ? (
          <p className="text-xs text-amber-400 mt-2">
            已截断（扫描 {treeMeta.entry_count_scanned} 条），可调大 /kb/browse-tree limit。
          </p>
        ) : null}
      </div>
      <div className="lg:col-span-5 flex flex-col rounded-xl border border-slate-700 bg-slate-800/40 p-3 max-h-[70vh]">
        <div className="flex gap-2 mb-2">
          <button
            type="button"
            onClick={() => setPreviewMode("summary")}
            className={`rounded px-3 py-1 text-xs ${previewMode === "summary" ? "bg-blue-600" : "bg-slate-700"}`}
          >
            摘要列表
          </button>
          <button
            type="button"
            onClick={() => setPreviewMode("markdown")}
            className={`rounded px-3 py-1 text-xs ${previewMode === "markdown" ? "bg-blue-600" : "bg-slate-700"}`}
          >
            Markdown
          </button>
        </div>
        <div className="flex-1 overflow-auto space-y-2">
          {treeDocs.length === 0 ? (
            <p className="text-slate-500 text-sm">该节点下暂无文档</p>
          ) : previewMode === "summary" ? (
            treeDocs.map((d) => (
              <button
                type="button"
                key={d.id}
                onClick={() => void openTreeDocument(d)}
                className="w-full text-left rounded-lg border border-slate-700 p-3 hover:bg-slate-700/40"
              >
                <div className="font-medium text-white">{d.title}</div>
                <div className="text-xs text-slate-500 mt-1">
                  {d.folder_path || "—"} · {d.collection}
                </div>
              </button>
            ))
          ) : (
            <div className="prose prose-invert prose-sm max-w-none">
              {treeDocs.map((d) => {
                const full = entryById.get(d.id);
                const body = full ? fullContent(full) : d.summary || "";
                const md = `# ${d.title}\n\n${body}`;
                return (
                  <div key={d.id} className="mb-6 border-b border-slate-700 pb-4">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <div className="lg:col-span-4 rounded-xl border border-slate-700 bg-slate-800/40 p-3 overflow-auto max-h-[70vh]">
        <p className="text-xs text-slate-500 mb-2">节点信息</p>
        {selectedTreeNode ? (
          <div className="text-sm text-slate-300 space-y-2">
            <p>
              域：
              <span className="text-white">{selectedTreeNode.domain ?? "—"}</span>
            </p>
            <p>
              路径：
              <span className="text-white">{selectedTreePath || "—"}</span>
            </p>
            <p>
              文档数：
              <span className="text-white">{treeDocs.length}</span>
            </p>
          </div>
        ) : (
          <p className="text-slate-500 text-sm">选择左侧节点</p>
        )}
        {selectedEntry ? (
          <div className="mt-4 border-t border-slate-700 pt-4">
            <p className="text-xs uppercase text-slate-500 mb-2">选中条目</p>
            <p className="text-white font-medium">{selectedEntry.title}</p>
            <p className="text-xs text-slate-500 mt-1">{selectedEntry.folder_path || "—"}</p>
          </div>
        ) : null}
      </div>
    </div>
  );

  const renderCollectionWorkspace = () => {
    const cols = collections.length > 0 ? collections : MOCK_COLLECTIONS;
    const rows =
      visibleBrowseEntries.length > 0
        ? visibleBrowseEntries
        : USE_MOCK_KB
          ? MOCK_ENTRIES
          : [];
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
              <span className="ml-2 text-slate-400 text-xs">({col.entry_count})</span>
            </button>
          ))}
        </div>
        <div className="space-y-3">
          {rows.length === 0 && (
            <p className="text-slate-500 text-center py-8 text-sm">
              暂无条目。可在外部 KB 同步后刷新，或切换到「检索验证」。
            </p>
          )}
          {rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((entry) => (
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
                <h3 className="text-lg font-semibold text-white">{entry.title}</h3>
                <span className="text-xs text-slate-500 bg-slate-700 px-2 py-1 rounded">
                  {entry.collection}
                </span>
              </div>
              <p className="text-slate-400 text-sm mb-3 line-clamp-2">{entry.summary}</p>
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span>来源：{entry.source}</span>
                <span>·</span>
                <span>{formatDate(entry.created_at)}</span>
                {entry.domain ? (
                  <>
                    <span>·</span>
                    <span>域 {entry.domain}</span>
                  </>
                ) : null}
                {entry.folder_path ? (
                  <>
                    <span>·</span>
                    <span className="truncate max-w-[200px]" title={entry.folder_path}>
                      {entry.folder_path}
                    </span>
                  </>
                ) : null}
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
        {rows.length > PAGE_SIZE && (
          <div className="flex justify-center gap-3 mt-6">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm hover:bg-slate-700 disabled:opacity-40"
            >
              上一页
            </button>
            <span className="px-4 py-2 text-slate-400 text-sm">第 {page + 1} 页</span>
            <button
              type="button"
              onClick={() =>
                setPage((p) =>
                  (p + 1) * PAGE_SIZE < rows.length ? p + 1 : p,
                )
              }
              disabled={(page + 1) * PAGE_SIZE >= rows.length}
              className="px-4 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm hover:bg-slate-700 disabled:opacity-40"
            >
              下一页
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderSearchView = () => (
    <div>
      <p className="text-xs text-slate-500 mb-2">
        默认跨全部 collection 检索（/kb/query-all）；可选限定其一。
      </p>
      <div className="flex flex-wrap gap-3 mb-4">
        <select
          value={searchScopeCollection}
          onChange={(e) => setSearchScopeCollection(e.target.value)}
          className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white min-w-[200px]"
        >
          <option value="">全部 collection</option>
          {(collections.length ? collections : MOCK_COLLECTIONS).map((c) => (
            <option key={c.name} value={c.name}>
              {c.description || c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex gap-3 mb-6">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          placeholder="输入关键词搜索知识库..."
          className="flex-1 px-4 py-3 bg-slate-800 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
        />
        <button
          onClick={handleSearch}
          disabled={isSearching || !searchQuery.trim()}
          className="px-6 py-3 bg-blue-600 rounded-lg hover:bg-blue-500 disabled:opacity-50 text-white font-medium"
        >
          {isSearching ? "搜索中..." : "搜索"}
        </button>
      </div>
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
                  : "border-slate-700 hover:bg-slate-700/40"
              }`}
            >
              <div className="flex items-start justify-between mb-2">
                <h3 className="text-lg font-semibold text-white">{entry.title}</h3>
                <span className="text-xs text-slate-500 bg-slate-700 px-2 py-1 rounded">
                  {entry.collection}
                </span>
              </div>
              <p className="text-slate-400 text-sm mb-2 line-clamp-2">{entry.summary}</p>
              {entry.folder_path ? (
                <p className="text-xs text-emerald-400/90">路径：{entry.folder_path}</p>
              ) : null}
              <div className="flex gap-4 text-xs text-slate-500 mt-2">
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

  const renderGraphWorkspace = () => {
    if (USE_MOCK_KB) {
      return (
        <p className="text-slate-500 text-sm text-center py-12">
          Mock 模式下图谱 API 不可用。
        </p>
      );
    }
    const nodesBlock = kgStats?.nodes as Record<string, number> | undefined;
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={kgBusy}
            onClick={() => void loadKgPanel()}
            className="rounded-lg bg-slate-700 px-4 py-2 text-sm"
          >
            刷新统计
          </button>
          <button
            type="button"
            disabled={kgBusy}
            onClick={() => void runKgValidate()}
            className="rounded-lg bg-slate-700 px-4 py-2 text-sm"
          >
            校验一致性
          </button>
          <button
            type="button"
            disabled={kgBusy}
            onClick={() => void loadKgNodes()}
            className="rounded-lg bg-slate-700 px-4 py-2 text-sm"
          >
            加载节点
          </button>
          <button
            type="button"
            disabled={kgBusy}
            onClick={() => void loadKgRels()}
            className="rounded-lg bg-slate-700 px-4 py-2 text-sm"
          >
            加载关系
          </button>
          <button
            type="button"
            disabled={kgBusy}
            onClick={() => void doKgExport()}
            className="rounded-lg border border-slate-600 px-4 py-2 text-sm"
          >
            导出 JSON
          </button>
        </div>
        {nodesBlock ? (
          <div className="grid gap-3 sm:grid-cols-5">
            {Object.entries(nodesBlock).map(([k, v]) => (
              <div key={k} className="rounded-xl border border-slate-700 bg-slate-800/50 p-3">
                <p className="text-xs text-slate-500">{k}</p>
                <p className="text-xl font-semibold text-white">{v}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-slate-500 text-sm">暂无统计，可先导入 bundle。</p>
        )}
        {kgValidate ? (
          <div
            className={`rounded-xl border p-4 text-sm ${
              kgValidate.ok
                ? "border-emerald-600/40 bg-emerald-900/20"
                : "border-amber-600/40 bg-amber-900/20"
            }`}
          >
            <p className="font-medium text-white mb-2">
              校验：{kgValidate.ok ? "通过" : `问题 ${kgValidate.errors.length} 条`}
            </p>
            <ul className="list-disc pl-5 text-slate-300 max-h-40 overflow-auto">
              {kgValidate.errors.slice(0, 30).map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div>
          <p className="text-sm text-slate-400 mb-2">
            批量导入（JSON：brands / vehicles / tech_insights / planned_vehicles / core_techs /
            relations）
          </p>
          <textarea
            value={kgImportText}
            onChange={(e) => setKgImportText(e.target.value)}
            className="w-full h-40 rounded-lg border border-slate-700 bg-slate-900 p-3 text-sm text-slate-200 font-mono"
            placeholder='{"brands":[{"brand_id":"x","name_cn":"示例"}]}'
          />
          <button
            type="button"
            disabled={kgBusy}
            onClick={() => void doKgImport()}
            className="mt-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white"
          >
            执行导入
          </button>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <div className="flex gap-2 mb-2">
              <select
                value={kgKindPick}
                onChange={(e) => setKgKindPick(e.target.value)}
                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white"
              >
                {KG_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
            <div className="max-h-64 overflow-auto rounded-lg border border-slate-700">
              <table className="w-full text-left text-xs text-slate-300">
                <tbody>
                  {kgNodes.map((row, i) => (
                    <tr key={i} className="border-b border-slate-800">
                      <td className="p-2 font-mono break-all">
                        {JSON.stringify(row).slice(0, 200)}…
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <p className="text-sm text-slate-400 mb-2">新增关系</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
                placeholder="rel_type"
                value={relForm.rel_type}
                onChange={(e) =>
                  setRelForm((f) => ({ ...f, rel_type: e.target.value }))
                }
              />
              <input
                className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
                placeholder="src_kind"
                value={relForm.src_kind}
                onChange={(e) =>
                  setRelForm((f) => ({ ...f, src_kind: e.target.value }))
                }
              />
              <input
                className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
                placeholder="src_id"
                value={relForm.src_id}
                onChange={(e) =>
                  setRelForm((f) => ({ ...f, src_id: e.target.value }))
                }
              />
              <input
                className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
                placeholder="dst_kind"
                value={relForm.dst_kind}
                onChange={(e) =>
                  setRelForm((f) => ({ ...f, dst_kind: e.target.value }))
                }
              />
              <input
                className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm"
                placeholder="dst_id"
                value={relForm.dst_id}
                onChange={(e) =>
                  setRelForm((f) => ({ ...f, dst_id: e.target.value }))
                }
              />
            </div>
            <button
              type="button"
              disabled={kgBusy}
              onClick={() => void addRelation()}
              className="mt-2 rounded-lg bg-blue-600 px-4 py-2 text-sm"
            >
              添加关系
            </button>
            <p className="text-xs text-slate-500 mt-4 mb-1">最近关系</p>
            <ul className="max-h-32 overflow-auto text-xs text-slate-400 space-y-1">
              {kgRelations.map((r) => (
                <li key={String(r.id)}>
                  {String(r.rel_type)} {String(r.src_kind)}:{String(r.src_id)} →{" "}
                  {String(r.dst_kind)}:{String(r.dst_id)}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    );
  };

  const renderIngestWorkspace = () => {
    if (USE_MOCK_KB) {
      return (
        <p className="text-slate-500 text-sm text-center py-12">
          Mock 模式下请关闭 NEXT_PUBLIC_USE_MOCK_KB 以使用上传与导入。
        </p>
      );
    }

    const onPickFiles = async (files: FileList | null) => {
      if (!files?.length) return;
      setIngestMessage(null);
      setIngestBusy(true);
      const ids: string[] = [];
      try {
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          const fd = new FormData();
          fd.append("file", f);
          const hint = ingestDocIdOnUpload.trim();
          if (hint) {
            fd.append("doc_id", hint);
          }
          const res = await apiFetch("/kb/upload", { method: "POST", body: fd });
          const j = (await res.json()) as { upload_id?: string; detail?: string };
          if (!res.ok) {
            throw new Error(typeof j.detail === "string" ? j.detail : `上传失败 HTTP ${res.status}`);
          }
          if (j.upload_id) ids.push(j.upload_id);
        }
        setIngestUploadIds((prev) => [...prev, ...ids]);
        setIngestMessage(`已上传 ${ids.length} 个文件`);
      } catch (e) {
        setIngestMessage(e instanceof Error ? e.message : "上传失败");
      } finally {
        setIngestBusy(false);
      }
    };

    const runIngest = async () => {
      if (!ingestCollection.trim()) {
        setIngestMessage("请填写 collection");
        return;
      }
      if (!ingestUploadIds.length) {
        setIngestMessage("请先上传文件");
        return;
      }
      setIngestBusy(true);
      setIngestMessage(null);
      try {
        let upload_doc_ids: Record<string, string> | undefined;
        const mapRaw = ingestUploadDocIdsJson.trim();
        if (mapRaw) {
          try {
            upload_doc_ids = JSON.parse(mapRaw) as Record<string, string>;
            if (
              !upload_doc_ids ||
              typeof upload_doc_ids !== "object" ||
              Array.isArray(upload_doc_ids)
            ) {
              throw new Error("需为对象");
            }
          } catch {
            setIngestMessage("upload_doc_ids JSON 须为 { upload_id: doc_id } 对象");
            setIngestBusy(false);
            return;
          }
        }
        const body: Record<string, unknown> = {
          source_type: "upload",
          collection: ingestCollection.trim(),
          project_id: ingestProjectId.trim() || "__all__",
          sync_cache: true,
          upload_ids: ingestUploadIds,
          defaults: {
            domain: ingestDomain.trim(),
            folder_path: ingestFolderPath.trim(),
            published: true,
            source: "manual_import",
            source_type: "file",
            language: "zh",
            doc_id_strategy: ingestDocIdStrategy,
          },
        };
        if (upload_doc_ids) {
          body.upload_doc_ids = upload_doc_ids;
        }
        const report = await apiPost<Record<string, unknown>>("/kb/ingest", body);
        const jid = typeof report.job_id === "string" ? report.job_id : null;
        setIngestJobId(jid);
        setIngestJobView(report);
        setIngestMessage(
          typeof report.status === "string" ? `任务状态：${report.status}` : "导入已完成",
        );
        void reloadKbBrowse();
        void reloadBrowseTree();
      } catch (e) {
        setIngestMessage(e instanceof Error ? e.message : "导入失败");
      } finally {
        setIngestBusy(false);
      }
    };

    const pollJob = async () => {
      if (!ingestJobId) return;
      try {
        const row = await apiGet<{
          status: string;
          result: Record<string, unknown> | null;
        }>(`/kb/ingest-jobs/${encodeURIComponent(ingestJobId)}`);
        setIngestJobView(row.result ?? { status: row.status });
        setIngestMessage(`任务 ${ingestJobId}：${row.status}`);
      } catch (e) {
        setIngestMessage(e instanceof Error ? e.message : "查询任务失败");
      }
    };

    return (
      <div className="space-y-6 max-w-3xl">
        <p className="text-sm text-slate-400">
          上传 Markdown / 纯文本 → 写入外部 Chroma → 同步 kb_cache。需后端可访问{" "}
          <code className="text-emerald-200/90">CHROMA_HOST</code>。
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="text-slate-400">collection</span>
            <input
              value={ingestCollection}
              onChange={(e) => setIngestCollection(e.target.value)}
              placeholder="public.structured_tech.topic"
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="text-slate-400">domain</span>
            <input
              value={ingestDomain}
              onChange={(e) => setIngestDomain(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="text-slate-400">folder_path</span>
            <input
              value={ingestFolderPath}
              onChange={(e) => setIngestFolderPath(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="text-slate-400">cache sync project_id</span>
            <input
              value={ingestProjectId}
              onChange={(e) => setIngestProjectId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="text-slate-400">上传时 doc_id（可选，写入服务器）</span>
            <input
              value={ingestDocIdOnUpload}
              onChange={(e) => setIngestDocIdOnUpload(e.target.value)}
              placeholder="稳定文档 ID，幂等更新 / publish"
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="text-slate-400">默认 doc_id 策略（无显式 doc_id 时）</span>
            <select
              value={ingestDocIdStrategy}
              onChange={(e) =>
                setIngestDocIdStrategy(e.target.value === "checksum" ? "checksum" : "filename")
              }
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
            >
              <option value="filename">原文件名 stem</option>
              <option value="checksum">sha256 前缀（跨重命名稳定）</option>
            </select>
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="text-slate-400">导入时 upload_id → doc_id 映射（JSON 可选）</span>
            <input
              value={ingestUploadDocIdsJson}
              onChange={(e) => setIngestUploadDocIdsJson(e.target.value)}
              placeholder='{"uuid-1":"my_doc_a"}'
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-mono"
            />
          </label>
        </div>
        <div>
          <input
            type="file"
            multiple
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            disabled={ingestBusy}
            onChange={(e) => void onPickFiles(e.target.files)}
            className="block w-full text-sm text-slate-300"
          />
          {ingestUploadIds.length > 0 ? (
            <p className="text-xs text-slate-500 mt-2">
              已选 upload_id：{ingestUploadIds.join(", ")}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={ingestBusy}
            onClick={() => void runIngest()}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            开始导入
          </button>
          <button
            type="button"
            disabled={!ingestJobId}
            onClick={() => void pollJob()}
            className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-200 disabled:opacity-40"
          >
            刷新任务状态
          </button>
          <button
            type="button"
            disabled={ingestBusy}
            onClick={() => {
              setIngestUploadIds([]);
              setIngestJobId(null);
              setIngestJobView(null);
              setIngestMessage(null);
              setIngestUploadDocIdsJson("");
            }}
            className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-200"
          >
            清空队列
          </button>
        </div>
        {ingestMessage ? (
          <p className="text-sm text-amber-200/90 whitespace-pre-wrap">{ingestMessage}</p>
        ) : null}
        {ingestJobView ? (
          <pre className="text-xs bg-slate-950/80 border border-slate-800 rounded-lg p-3 overflow-auto max-h-64 text-slate-300">
            {JSON.stringify(ingestJobView, null, 2)}
          </pre>
        ) : null}
      </div>
    );
  };

  const renderDetailPanel = (entry: KBEntry) => {
    const fromEntry = entryById.get(entry.id) ?? entry;
    const projectId =
      fromEntry.projects[0] != null ? String(fromEntry.projects[0]) : "__all__";
    const mdBody = fullContent(entry);

    return (
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
            <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">来源</p>
            <p className="text-slate-300">{entry.source}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">域 / 路径</p>
            <p className="text-slate-300 text-sm">
              {entry.domain ?? "—"} {entry.folder_path ? `· ${entry.folder_path}` : ""}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">发布</p>
            <p className="text-slate-300 text-sm">
              {entry.published === false ? "否（仅治理）" : "是 / 未标注"}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">正文预览</p>
            <div className="prose prose-invert prose-sm max-w-none text-slate-300">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{mdBody || "—"}</ReactMarkdown>
            </div>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">Collection</p>
            <p className="text-slate-300">{entry.collection}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">linked_kg_ids（metadata）</p>
            <p className="text-slate-300 text-sm font-mono">
              {entry.linked_kg_ids?.length
                ? entry.linked_kg_ids.join(", ")
                : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide mb-2">
              图谱关联（kb_kg_link）
            </p>
            <div className="flex gap-2 flex-wrap mb-2">
              <select
                value={kgLinkKind}
                onChange={(e) => setKgLinkKind(e.target.value)}
                className="rounded border border-slate-600 bg-slate-900 text-sm px-2 py-1"
              >
                {KG_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <input
                value={kgLinkNodeId}
                onChange={(e) => setKgLinkNodeId(e.target.value)}
                placeholder="节点 ID"
                className="rounded border border-slate-600 bg-slate-900 text-sm px-2 py-1 flex-1 min-w-[120px]"
              />
              <button
                type="button"
                onClick={() => void addKgLink()}
                className="rounded bg-blue-600 px-3 py-1 text-sm disabled:opacity-40"
                disabled={USE_MOCK_KB}
              >
                绑定
              </button>
            </div>
            <ul className="text-sm text-slate-400 space-y-1">
              {kgLinks.map((l) => (
                <li key={l.id} className="flex justify-between gap-2">
                  <span>
                    {l.kg_kind}:{l.kg_node_id}
                  </span>
                  <button
                    type="button"
                    className="text-rose-400 text-xs disabled:opacity-40"
                    disabled={USE_MOCK_KB}
                    onClick={() => void removeKgLink(l.id)}
                  >
                    移除
                  </button>
                </li>
              ))}
            </ul>
            <p className="text-xs text-slate-600 mt-2">project_id 上下文：{projectId}</p>
          </div>
          {entry.projects.length > 0 && (
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wide mb-2">关联项目</p>
              <div className="flex gap-2 flex-wrap">
                {entry.projects.map((pid) => (
                  <Link
                    key={pid}
                    href={`/projects/${pid}`}
                    onClick={(e) => e.stopPropagation()}
                    className="px-3 py-1.5 bg-blue-600/20 border border-blue-500/40 rounded-lg text-blue-300 text-sm"
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
  };

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
                公共知识库：<strong className="text-slate-200">目录树</strong>治理与{" "}
                <strong className="text-slate-200">知识图谱</strong>
                信息点；执行侧仍只消费场景{" "}
                <code className="text-emerald-200/90">knowledge_policy.collections</code>。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link
                href="/projects"
                className="rounded-xl border border-slate-700 bg-slate-900/70 px-4 py-2.5 text-sm font-medium text-slate-200 transition hover:border-slate-600"
              >
                查看项目中心
              </Link>
              <a
                href="#kb-workspace"
                className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-2.5 text-sm font-medium text-emerald-200 transition hover:border-emerald-400"
              >
                知识库工作区
              </a>
            </div>
          </div>
        </header>

        <section className="mb-6 grid gap-3 md:grid-cols-4">
          <MetricCard label="知识集合" value={String(collectionCount)} hint="可作为知识范围" />
          <MetricCard label="缓存条目" value={String(browseCount)} hint="当前浏览基线" />
          <MetricCard
            label="已绑定项目"
            value={String(boundProjectIds.size)}
            hint="出现过项目关联"
          />
          <MetricCard
            label="项目入口"
            value={String(projects.length)}
            hint={
              projectBoundCount > 0
                ? `${projectBoundCount} 条已有项目关联`
                : "建议逐步按项目收口"
            }
          />
        </section>

        <KBDegradedBanner />

        <section id="kb-workspace" className="rounded-3xl border border-slate-800 bg-slate-900/50 p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Knowledge Workspace</p>
              <h2 className="mt-2 text-xl font-semibold text-white">目录 · 集合 · 检索 · 图谱 · 导入</h2>
            </div>
            <div className="flex flex-wrap gap-1 rounded-lg border border-slate-700 bg-slate-800/60 p-1">
              {(
                [
                  ["tree", "目录浏览"],
                  ["collections", "按集合"],
                  ["search", "检索验证"],
                  ["graph", "知识图谱"],
                  ["ingest", "上传导入"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => handleWorkspaceMode(k)}
                  className={`rounded-md px-4 py-2 text-sm font-medium transition ${
                    workspaceMode === k
                      ? "bg-blue-600 text-white"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-6">
            {workspaceMode === "tree" && renderTreeWorkspace()}
            {workspaceMode === "collections" && renderCollectionWorkspace()}
            {workspaceMode === "search" && renderSearchView()}
            {workspaceMode === "graph" && renderGraphWorkspace()}
            {workspaceMode === "ingest" && renderIngestWorkspace()}
          </div>
        </section>

        {selectedEntry &&
          workspaceMode !== "graph" &&
          workspaceMode !== "ingest" &&
          renderDetailPanel(selectedEntry)}
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

