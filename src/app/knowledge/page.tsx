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
import { apiDelete, apiFetch, apiGet, apiPatch, apiPost, getPublicApiBase } from "@/lib/api";
import { CONTENT_MAX_CLASS } from "@/lib/content-shell";
import { KbMarkdown } from "@/components/kb-markdown";
import type { KbMarkdownAssetContext } from "@/lib/kb-markdown-assets";
import {
  fieldLabel,
  isPublicKbCollection,
  kbCollectionLabel,
  KB_DOMAIN_LABELS,
  kbDomainLabel,
  kbSourceTypeLabel,
  kgKindLabel,
  runStatusLabel,
} from "@/lib/ui-labels";

// ============== 类型 ==============
interface KBEntry {
  id: string;
  doc_id?: string;
  title: string;
  source: string;
  summary: string;
  /** 完整正文（来自缓存 content） */
  body?: string;
  collection: string;
  domain?: string;
  folder_path?: string;
  /** 相对 Obsidian Vault 根的源 .md 路径（导入时写入 metadata） */
  source_vault_file?: string;
  published?: boolean;
  linked_kg_ids?: string[];
  created_at: string;
  projects: number[];
  source_type?: string;
  conversation_id?: string;
  confidence?: number | string;
  harvested_from_user_confirmed?: boolean;
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

type SourceTypeFilter =
  | "all"
  | "conversation_harvest"
  | "file"
  | "upload";

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
  const source_vault_file =
    typeof meta.source_vault_file === "string" && meta.source_vault_file
      ? meta.source_vault_file
      : undefined;
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
  const source_type =
    typeof meta.source_type === "string" && meta.source_type
      ? meta.source_type
      : undefined;
  const doc_id = typeof meta.doc_id === "string" && meta.doc_id ? meta.doc_id : undefined;
  const conversation_id =
    typeof meta.conversation_id === "string" && meta.conversation_id
      ? meta.conversation_id
      : undefined;
  let confidence: number | string | undefined = meta.confidence as number | string | undefined;
  if (confidence === undefined || confidence === null || confidence === "") {
    confidence = undefined;
  }
  let harvested: boolean | undefined;
  const h = meta.harvested_from_user_confirmed;
  if (typeof h === "boolean") harvested = h;
  else if (typeof h === "string")
    harvested = ["1", "true", "yes", "on"].includes(h.toLowerCase());
  return {
    id: String(row.id ?? ""),
    doc_id,
    title,
    source: String(row.source ?? meta.source ?? "缓存"),
    summary: String(row.content ?? "").slice(0, 280),
    body: String(row.content ?? ""),
    collection: String(row.collection ?? ""),
    created_at: String(row.created_at ?? row.updated_at ?? ""),
    projects,
    domain,
    folder_path,
    source_vault_file,
    linked_kg_ids,
    published,
    source_type,
    conversation_id,
    confidence,
    harvested_from_user_confirmed: harvested,
  };
}

function kbAssetContextFromEntry(
  entry: Pick<KBEntry, "folder_path" | "source_vault_file">,
): KbMarkdownAssetContext {
  return {
    folderPath: entry.folder_path,
    sourceVaultFile: entry.source_vault_file,
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
  const source_vault_file =
    typeof meta.source_vault_file === "string" && meta.source_vault_file
      ? meta.source_vault_file
      : undefined;
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
  const st =
    typeof meta.source_type === "string" && meta.source_type ? meta.source_type : undefined;
  const dq = typeof meta.doc_id === "string" && meta.doc_id ? meta.doc_id : undefined;

  return {
    id: String(meta.id ?? `hit_${i}`),
    doc_id: dq,
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
    source_vault_file,
    linked_kg_ids,
    source_type: st,
    published:
      typeof meta.published === "boolean"
        ? meta.published
        : typeof meta.published === "string"
          ? ["1", "true", "yes", "on"].includes(meta.published.toLowerCase())
          : undefined,
  };
}

function formatDate(dateStr: string): string {
  return dateStr || "未知";
}

function resolveDocId(entry: Pick<KBEntry, "id" | "doc_id">): string | null {
  const explicit = entry.doc_id?.trim();
  if (explicit) return explicit;
  const m = /^(.+)_chunk_\d+$/.exec(entry.id);
  if (m?.[1]) return m[1];
  return entry.id?.trim() || null;
}

function dedupeKbEntriesByDocId(entries: KBEntry[]): KBEntry[] {
  const seen = new Map<string, KBEntry>();
  for (const e of entries) {
    const did = resolveDocId(e) ?? e.id;
    if (!seen.has(did)) seen.set(did, e);
  }
  return [...seen.values()];
}

function dedupeBrowseDocsByDocId(docs: BrowseDoc[]): BrowseDoc[] {
  const seen = new Map<string, BrowseDoc>();
  for (const d of docs) {
    const did = resolveDocId({ id: d.id }) ?? d.id;
    if (!seen.has(did)) seen.set(did, d);
  }
  return [...seen.values()];
}

function entryEditFormFrom(entry: KBEntry, body: string) {
  return {
    title: entry.title,
    domain: entry.domain && entry.domain !== "_uncategorized" ? entry.domain : "structured_tech",
    folder_path: entry.folder_path || "02-知识库/导入",
    published: entry.published !== false,
    content: body,
  };
}

function collectDocsFromTree(node: TreeNode): BrowseDoc[] {
  const out = [...(node.documents || [])];
  for (const ch of node.children || []) {
    out.push(...collectDocsFromTree(ch));
  }
  return out;
}

function treeSelectionKey(node: TreeNode, depth: number, index: number): string {
  return node.path || treeNodeKey(node, depth, index);
}

function treeNodeFolderPath(node: TreeNode): string {
  return (node.path || "").trim();
}

function defaultImportFolderForNode(node: TreeNode): string {
  const fp = treeNodeFolderPath(node);
  if (fp) return fp;
  const dom = node.domain?.trim();
  if (dom && dom !== "_uncategorized") {
    return `02-知识库/${dom}`;
  }
  return "02-知识库/待分类";
}

function defaultImportDomainForNode(node: TreeNode): string {
  const dom = node.domain?.trim();
  if (dom && dom !== "_uncategorized") return dom;
  return "structured_tech";
}

interface TreeNodeStats {
  directCount: number;
  subtreeCount: number;
  childFolderCount: number;
  draftCount: number;
  unclassifiedCount: number;
  harvestCount: number;
  collectionCounts: { name: string; count: number }[];
}

function computeTreeNodeStats(
  node: TreeNode | null,
  subtreeDocs: BrowseDoc[],
  directDocs: BrowseDoc[],
): TreeNodeStats {
  const colMap = new Map<string, number>();
  let draftCount = 0;
  let unclassifiedCount = 0;
  let harvestCount = 0;
  for (const d of subtreeDocs) {
    colMap.set(d.collection, (colMap.get(d.collection) ?? 0) + 1);
    if (d.published === false) draftCount += 1;
    if (!entryClassifyStatus({ domain: d.domain, folder_path: d.folder_path }).ok) {
      unclassifiedCount += 1;
    }
    const full = d as BrowseDoc & { source_type?: string };
    if (full.source_type === "conversation_harvest") harvestCount += 1;
  }
  const collectionCounts = [...colMap.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
  return {
    directCount: directDocs.length,
    subtreeCount: subtreeDocs.length,
    childFolderCount: node?.children?.length ?? 0,
    draftCount,
    unclassifiedCount,
    harvestCount,
    collectionCounts,
  };
}

function treeNodeDisplayLabel(node: TreeNode, depth: number): string {
  if (depth === 0 && node.domain) {
    return kbDomainLabel(node.domain);
  }
  if (node.segment) return node.segment;
  return "本目录";
}

function entryClassifyStatus(entry: Pick<KBEntry, "domain" | "folder_path">): {
  ok: boolean;
  label: string;
  hint: string;
} {
  const hasDomain = !!entry.domain?.trim() && entry.domain !== "_uncategorized";
  const hasPath = !!entry.folder_path?.trim();
  if (hasDomain && hasPath) {
    return { ok: true, label: "已分类", hint: "domain + folder_path 完整" };
  }
  if (!hasDomain && !hasPath) {
    return { ok: false, label: "未分类", hint: "缺少 domain 与 folder_path" };
  }
  if (!hasDomain) {
    return { ok: false, label: "缺业务域", hint: "metadata.domain 未设置" };
  }
  return { ok: false, label: "缺目录路径", hint: "metadata.folder_path 未设置" };
}

function KbClassifyRulesHint({ compact }: { compact?: boolean }) {
  return (
    <div
      className={`rounded-lg border border-slate-300 dark:border-slate-700/80 bg-white/90 dark:bg-slate-900/60 text-slate-400 ${
        compact ? "px-3 py-2 text-xs" : "px-4 py-3 text-sm"
      }`}
    >
      <p className="text-slate-700 dark:text-slate-300 font-medium mb-1">分类规则</p>
      <ul className={`space-y-0.5 ${compact ? "text-[11px]" : "text-xs"} list-disc pl-4`}>
        <li>
          <strong className="text-slate-700 dark:text-slate-300">目录浏览</strong>：按 metadata{" "}
          <code className="text-emerald-300/90">domain</code>（业务域）+{" "}
          <code className="text-emerald-300/90">folder_path</code>（Obsidian 目录，用 / 分隔）生成树
        </li>
        <li>
          <strong className="text-slate-700 dark:text-slate-300">按集合</strong>：按 Chroma{" "}
          <code className="text-emerald-300/90">collection</code> 分组，规范名如{" "}
          <code className="text-emerald-300/90">public.structured_tech.geely_tech</code>
        </li>
        <li>导入时在「上传导入」填写 domain / folder_path，或在 metadata 中补全后刷新</li>
      </ul>
    </div>
  );
}

/** 树节点 React key：顶层域节点 path/segment 均为空，需用 domain 区分 */
function treeNodeKey(node: TreeNode, depth: number, index: number): string {
  if (node.path) return node.path;
  if (node.domain) return `domain:${node.domain}`;
  if (node.segment) return `${depth}:${node.segment}`;
  return `${depth}:node:${index}`;
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
  onSelect: (key: string, node: TreeNode) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    depth === 0
      ? Object.fromEntries(nodes.map((n, i) => [treeNodeKey(n, depth, i), true]))
      : {},
  );

  return (
    <ul className={depth === 0 ? "space-y-0.5" : "mt-0.5 space-y-0.5 border-l border-slate-700 pl-2 ml-1"}>
      {nodes.map((n, i) => {
        const key = treeSelectionKey(n, depth, i);
        const label = treeNodeDisplayLabel(n, depth);
        const isSelected = selectedPath === key;
        const hasKids = (n.children?.length ?? 0) > 0;
        const expanded = open[key] ?? depth < 1;
        const directDocs = n.documents?.length ?? 0;

        return (
          <li key={key}>
            <div className="flex items-center gap-1">
              {hasKids ? (
                <button
                  type="button"
                  className="text-slate-500 w-5 text-xs shrink-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen((o) => ({ ...o, [key]: !expanded }));
                  }}
                  aria-label={expanded ? "折叠" : "展开"}
                >
                  {expanded ? "▾" : "▸"}
                </button>
              ) : (
                <span className="w-5 shrink-0" />
              )}
              <button
                type="button"
                onClick={() => onSelect(key, n)}
                className={`flex-1 min-w-0 text-left rounded px-2 py-1 text-sm ${
                  isSelected
                    ? "bg-blue-600/30 text-white"
                    : "text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:bg-slate-800"
                }`}
                title={
                  depth === 0 && n.domain
                    ? `${n.domain} · ${n.document_count ?? 0} 篇`
                    : n.path || label
                }
              >
                <span className="truncate block">{label}</span>
                <span className="text-[10px] text-slate-500">
                  {n.document_count ?? n.total_documents ?? 0} 篇
                  {directDocs > 0 && hasKids ? ` · 本级 ${directDocs}` : ""}
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
    "tree" | "collections" | "search" | "graph" | "ingest" | "harvest"
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
  const [filterSourceType, setFilterSourceType] = useState<SourceTypeFilter>("all");
  const [harvestPublishFilter, setHarvestPublishFilter] = useState<
    "draft" | "published" | "all"
  >("draft");
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishMessage, setPublishMessage] = useState<string | null>(null);
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
  const [selectedTreeKey, setSelectedTreeKey] = useState("");
  const [selectedTreeFolderPath, setSelectedTreeFolderPath] = useState("");
  const [selectedTreeNode, setSelectedTreeNode] = useState<TreeNode | null>(null);
  const [treeDocs, setTreeDocs] = useState<BrowseDoc[]>([]);
  const [treeDocQuery, setTreeDocQuery] = useState("");
  const [treeDocScope, setTreeDocScope] = useState<
    "subtree" | "direct" | "draft" | "unclassified"
  >("subtree");
  const [treeTargetDomain, setTreeTargetDomain] = useState("structured_tech");
  const [treeTargetFolderPath, setTreeTargetFolderPath] = useState("");
  const [treeNodeDocFilter, setTreeNodeDocFilter] = useState<Set<string> | null>(null);
  const [nodeManageMessage, setNodeManageMessage] = useState<string | null>(null);
  const [showUnclassifiedOnly, setShowUnclassifiedOnly] = useState(false);

  const [entryEditing, setEntryEditing] = useState(false);
  const [entryEditForm, setEntryEditForm] = useState({
    title: "",
    domain: "structured_tech",
    folder_path: "02-知识库/导入",
    published: true,
    content: "",
  });
  const [entryManageBusy, setEntryManageBusy] = useState(false);
  const [entryManageMessage, setEntryManageMessage] = useState<string | null>(null);
  const [showCreateEntry, setShowCreateEntry] = useState(false);
  const [createEntryForm, setCreateEntryForm] = useState({
    collection: "",
    title: "",
    content: "",
    domain: "structured_tech",
    folder_path: "02-知识库/手动录入",
    published: true,
    doc_id: "",
  });

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

  const onTreeSelect = useCallback((key: string, node: TreeNode) => {
    setSelectedTreeKey(key);
    setSelectedTreeFolderPath(treeNodeFolderPath(node));
    setSelectedTreeNode(node);
    setTreeDocs(collectDocsFromTree(node));
    setTreeDocQuery("");
    setTreeDocScope("subtree");
    setTreeTargetDomain(defaultImportDomainForNode(node));
    setTreeTargetFolderPath(defaultImportFolderForNode(node));
    setNodeManageMessage(null);
    setSelectedEntry(null);
  }, []);

  const projectNameMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of projects) {
      m[p.id] = p.name;
    }
    return m;
  }, [projects]);

  const unclassifiedCount = useMemo(
    () =>
      browseEntries.filter(
        (e) =>
          !e.domain?.trim() ||
          e.domain === "_uncategorized" ||
          !e.folder_path?.trim(),
      ).length,
    [browseEntries],
  );

  const filteredTreeDocs = useMemo(() => {
    let base = treeDocs;
    if (treeDocScope === "direct" && selectedTreeNode) {
      base = selectedTreeNode.documents || [];
    } else if (treeDocScope === "draft") {
      base = treeDocs.filter((d) => d.published === false);
    } else if (treeDocScope === "unclassified") {
      base = treeDocs.filter(
        (d) => !entryClassifyStatus({ domain: d.domain, folder_path: d.folder_path }).ok,
      );
    }
    const q = treeDocQuery.trim().toLowerCase();
    return base.filter((d) => {
      if (q) {
        const hay = `${d.title} ${d.folder_path ?? ""} ${d.collection} ${d.domain ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [treeDocs, treeDocQuery, treeDocScope, selectedTreeNode]);

  const displayTreeDocs = useMemo(
    () => dedupeBrowseDocsByDocId(filteredTreeDocs),
    [filteredTreeDocs],
  );

  const treeNodeStats = useMemo(() => {
    const base = computeTreeNodeStats(
      selectedTreeNode,
      treeDocs,
      selectedTreeNode?.documents || [],
    );
    let harvestCount = 0;
    for (const d of treeDocs) {
      const full = entryById.get(d.id);
      if (full?.source_type === "conversation_harvest") harvestCount += 1;
    }
    return { ...base, harvestCount };
  }, [selectedTreeNode, treeDocs, entryById]);

  useEffect(() => {
    if (browseTree.length > 0 && !selectedTreeKey) {
      const first = browseTree[0];
      if (first) {
        onTreeSelect(treeSelectionKey(first, 0, 0), first);
      }
    }
  }, [browseTree, selectedTreeKey, onTreeSelect]);

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
    if (m === "harvest") {
      setFilterSourceType("conversation_harvest");
      setFilterCollection(null);
      setShowUnclassifiedOnly(false);
      setHarvestPublishFilter("draft");
    } else if (workspaceMode === "harvest") {
      setFilterSourceType("all");
    }
    if (m !== "collections") {
      setTreeNodeDocFilter(null);
    }
    setWorkspaceMode(m);
    setSelectedEntry(null);
    setPage(0);
    if (m === "search") {
      setSearchResults([]);
      setSearchQuery("");
      setSearchScopeCollection("");
    }
  };

  const jumpToIngestFromTree = () => {
    setIngestDomain(treeTargetDomain.trim() || "structured_tech");
    setIngestFolderPath(treeTargetFolderPath.trim() || "02-知识库/导入");
    handleWorkspaceMode("ingest");
  };

  const jumpToCreateFromTree = () => {
    const col =
      treeNodeStats.collectionCounts[0]?.name ||
      collections.find((c) => c.name.includes(treeTargetDomain))?.name ||
      collections[0]?.name ||
      "";
    setCreateEntryForm((f) => ({
      ...f,
      collection: col,
      domain: treeTargetDomain.trim() || "structured_tech",
      folder_path: treeTargetFolderPath.trim() || "02-知识库/手动录入",
    }));
    setShowCreateEntry(true);
    setPage(0);
  };

  const jumpToCollectionsForNode = () => {
    const ids = new Set<string>();
    for (const d of treeDocs) {
      ids.add(d.id);
      const m = /^(.+)_chunk_\d+$/.exec(d.id);
      if (m?.[1]) ids.add(m[1]);
    }
    setTreeNodeDocFilter(ids);
    setFilterCollection(null);
    setFilterSourceType("all");
    setShowUnclassifiedOnly(false);
    handleWorkspaceMode("collections");
  };

  const copyTreeFolderPath = async () => {
    const text = treeTargetFolderPath.trim() || selectedTreeFolderPath || "";
    if (!text) {
      setNodeManageMessage("当前为域根，无 folder_path 可复制；可在下方设置导入路径。");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setNodeManageMessage("已复制目录路径");
    } catch {
      setNodeManageMessage("复制失败");
    }
  };

  const jumpToCollectionFromDoc = (collection: string) => {
    setFilterCollection(collection);
    setFilterSourceType("all");
    handleWorkspaceMode("collections");
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
    setPublishMessage(null);
    setEntryManageMessage(null);
    setEntryEditing(false);
    if (selectedEntry?.id === entry.id) {
      setSelectedEntry(null);
      return;
    }
    setSelectedEntry(entry);
  };

  const saveEntryEdit = async () => {
    if (!selectedEntry || USE_MOCK_KB || entryManageBusy) return;
    const fromEntry = entryById.get(selectedEntry.id) ?? selectedEntry;
    const docId = resolveDocId(fromEntry);
    if (!docId) {
      setEntryManageMessage("无法解析 doc_id，暂不支持编辑。");
      return;
    }
    const projectId =
      fromEntry.projects[0] != null ? String(fromEntry.projects[0]) : "__all__";
    setEntryManageBusy(true);
    setEntryManageMessage(null);
    try {
      await apiPatch("/kb/entries/" + encodeURIComponent(docId), {
        collection: fromEntry.collection,
        project_id: projectId,
        sync_cache: true,
        title: entryEditForm.title.trim(),
        content: entryEditForm.content,
        metadata: {
          domain: entryEditForm.domain.trim(),
          folder_path: entryEditForm.folder_path.trim(),
          published: entryEditForm.published,
        },
      });
      setEntryManageMessage("已保存并同步缓存。");
      setEntryEditing(false);
      await reloadKbBrowse();
      await reloadBrowseTree();
    } catch (e) {
      setEntryManageMessage(e instanceof Error ? e.message : "保存失败");
    } finally {
      setEntryManageBusy(false);
    }
  };

  const deleteKbDocument = async (
    entry: Pick<KBEntry, "id" | "doc_id" | "collection" | "projects" | "title">,
    confirmTitle?: string,
  ) => {
    if (USE_MOCK_KB || entryManageBusy) return false;
    const docId = resolveDocId(entry);
    if (!docId) {
      const msg = "无法解析 doc_id，暂不支持删除。";
      setEntryManageMessage(msg);
      setNodeManageMessage(msg);
      return false;
    }
    const label = confirmTitle || entry.title || docId;
    if (
      !window.confirm(
        `确定删除知识点「${label}」？\n将移除 Chroma 中该 doc 的全部 chunk，不可恢复。`,
      )
    ) {
      return false;
    }
    const projectId =
      entry.projects[0] != null ? String(entry.projects[0]) : "__all__";
    setEntryManageBusy(true);
    setEntryManageMessage(null);
    setNodeManageMessage(null);
    try {
      await apiDelete(
        `/kb/entries/${encodeURIComponent(docId)}?collection=${encodeURIComponent(entry.collection)}&project_id=${encodeURIComponent(projectId)}`,
      );
      if (selectedEntry && resolveDocId(selectedEntry) === docId) {
        setSelectedEntry(null);
        setEntryEditing(false);
      }
      await reloadKbBrowse();
      await reloadBrowseTree();
      setNodeManageMessage(`已删除：${label}`);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "删除失败";
      const hint = msg.includes("404") ? "删除接口不可用，请重启后端（./stop.sh && ./start.sh）" : msg;
      setEntryManageMessage(hint);
      setNodeManageMessage(hint);
      return false;
    } finally {
      setEntryManageBusy(false);
    }
  };

  const deleteSelectedEntry = async () => {
    if (!selectedEntry) return;
    const fromEntry = entryById.get(selectedEntry.id) ?? selectedEntry;
    await deleteKbDocument(fromEntry, fromEntry.title);
  };

  const deleteTreeDocument = async (d: BrowseDoc) => {
    const full = entryById.get(d.id);
    await deleteKbDocument(
      full ?? {
        id: d.id,
        doc_id: resolveDocId({ id: d.id }) ?? undefined,
        collection: d.collection,
        projects: [],
        title: d.title,
      },
      d.title,
    );
  };

  const deleteCollectionAll = async (collectionName: string, label: string, count: number) => {
    if (USE_MOCK_KB || entryManageBusy) return;
    if (
      !window.confirm(
        `确定删除合集「${label}」下的全部内容？\n约 ${count} 条缓存 / 全部 Chroma chunk，不可恢复。`,
      )
    ) {
      return;
    }
    const typed = window.prompt(`二次确认：请输入合集名 "${collectionName}" 以继续删除`);
    if (typed?.trim() !== collectionName) {
      setEntryManageMessage("合集名不匹配，已取消删除。");
      return;
    }
    setEntryManageBusy(true);
    setEntryManageMessage(null);
    try {
      await apiDelete(
        `/kb/collections/${encodeURIComponent(collectionName)}/entries?confirm=true&project_id=__all__`,
      );
      if (selectedEntry?.collection === collectionName) {
        setSelectedEntry(null);
        setEntryEditing(false);
      }
      if (filterCollection === collectionName) {
        setFilterCollection(null);
      }
      setTreeNodeDocFilter(null);
      await reloadKbBrowse();
      await reloadBrowseTree();
      setEntryManageMessage(`已删除合集：${label}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "合集删除失败";
      setEntryManageMessage(msg.includes("404") ? "合集删除接口不可用，请重启后端。" : msg);
    } finally {
      setEntryManageBusy(false);
    }
  };

  const createManualEntry = async () => {
    if (USE_MOCK_KB || entryManageBusy) return;
    const col = createEntryForm.collection.trim();
    if (!col || !createEntryForm.title.trim() || !createEntryForm.content.trim()) {
      setEntryManageMessage("请填写集合、标题与正文。");
      return;
    }
    setEntryManageBusy(true);
    setEntryManageMessage(null);
    try {
      const res = await apiPost<{ entry_id?: string; doc_id?: string }>("/kb/entries/manual", {
        collection: col,
        project_id: ingestProjectId || "__all__",
        title: createEntryForm.title.trim(),
        content: createEntryForm.content,
        domain: createEntryForm.domain.trim(),
        folder_path: createEntryForm.folder_path.trim(),
        published: createEntryForm.published,
        doc_id: createEntryForm.doc_id.trim() || undefined,
        sync_cache: true,
      });
      setEntryManageMessage("条目已创建。");
      setShowCreateEntry(false);
      setCreateEntryForm((f) => ({
        ...f,
        title: "",
        content: "",
        doc_id: "",
      }));
      await reloadKbBrowse();
      await reloadBrowseTree();
      if (res.entry_id) {
        const hit = browseEntries.find((e) => e.id === res.entry_id);
        if (hit) handleEntryClick(hit);
      }
    } catch (e) {
      setEntryManageMessage(e instanceof Error ? e.message : "创建失败");
    } finally {
      setEntryManageBusy(false);
    }
  };

  const publishHarvestEntry = async (entry: KBEntry, published: boolean) => {
    const docId = entry.doc_id?.trim();
    if (!docId || USE_MOCK_KB || publishBusy) return;
    const projectId =
      entry.projects[0] != null ? String(entry.projects[0]) : "__all__";
    setPublishBusy(true);
    setPublishMessage(null);
    try {
      await apiPost("/kb/publish", {
        collection: entry.collection,
        doc_ids: [docId],
        published,
        project_id: projectId,
        sync_cache: true,
      });
      setPublishMessage(published ? "已发布并完成缓存同步。" : "已保持草稿（未对外发布）。");
      await reloadKbBrowse();
      setSelectedEntry((prev) =>
        prev && prev.id === entry.id ? { ...prev, published } : prev,
      );
    } catch {
      setPublishMessage("发布状态更新失败。");
    } finally {
      setPublishBusy(false);
    }
  };

  function entryMatchesSourceFilter(e: KBEntry): boolean {
    if (filterSourceType === "all") return true;
    const st = e.source_type ?? "file";
    return st === filterSourceType;
  }

  const visibleBrowseEntries = browseEntries.filter((e) => {
    if (treeNodeDocFilter) {
      const did = resolveDocId(e);
      if (!treeNodeDocFilter.has(e.id) && !(did && treeNodeDocFilter.has(did))) {
        return false;
      }
    }
    if (filterCollection && e.collection !== filterCollection) return false;
    if (showUnclassifiedOnly && entryClassifyStatus(e).ok) return false;
    return entryMatchesSourceFilter(e);
  });

  const harvestAllEntries = useMemo(
    () =>
      dedupeKbEntriesByDocId(
        browseEntries.filter((e) => e.source_type === "conversation_harvest"),
      ),
    [browseEntries],
  );

  const harvestStats = useMemo(() => {
    const draft = harvestAllEntries.filter((e) => e.published === false);
    const published = harvestAllEntries.filter((e) => e.published !== false);
    return {
      total: harvestAllEntries.length,
      draft: draft.length,
      published: published.length,
    };
  }, [harvestAllEntries]);

  const harvestVisibleEntries = useMemo(() => {
    if (harvestPublishFilter === "draft") {
      return harvestAllEntries.filter((e) => e.published === false);
    }
    if (harvestPublishFilter === "published") {
      return harvestAllEntries.filter((e) => e.published !== false);
    }
    return harvestAllEntries;
  }, [harvestAllEntries, harvestPublishFilter]);
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

  useEffect(() => {
    if (!selectedEntry) {
      setEntryEditing(false);
      return;
    }
    const fromEntry = entryById.get(selectedEntry.id) ?? selectedEntry;
    setEntryEditForm(entryEditFormFrom(fromEntry, fullContent(fromEntry)));
  }, [selectedEntry, entryById, browseEntries]);

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

  const renderTreeDocRow = (d: BrowseDoc) => {
    const full = entryById.get(d.id);
    const classify = entryClassifyStatus(
      full ?? { domain: d.domain, folder_path: d.folder_path },
    );
    return (
      <div
        key={d.id}
        className={`rounded-lg border p-3 transition ${
          selectedEntry?.id === d.id
            ? "border-blue-500 bg-slate-700/50"
            : "border-slate-300 dark:border-slate-700 hover:bg-slate-300/40 dark:bg-slate-700/40"
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <button
            type="button"
            onClick={() => void openTreeDocument(d)}
            className="flex-1 min-w-0 text-left"
          >
            <div className="font-medium text-slate-900 dark:text-white truncate">{d.title}</div>
            <div className="text-xs text-slate-500 mt-1 truncate">
              {d.folder_path || "—"} · {kbCollectionLabel(d.collection, { projectNames: projectNameMap })}
            </div>
          </button>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded ${
                classify.ok
                  ? "bg-emerald-500/15 text-emerald-300"
                  : "bg-amber-500/15 text-amber-200"
              }`}
              title={classify.hint}
            >
              {classify.label}
            </span>
            {d.published === false ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-200">
                草稿
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5 mt-2">
          <button
            type="button"
            onClick={() => void openTreeDocument(d)}
            className="rounded px-2 py-0.5 text-[11px] bg-blue-600/80 text-white hover:bg-blue-500"
          >
            详情
          </button>
          <button
            type="button"
            onClick={() => jumpToCollectionFromDoc(d.collection)}
            className="rounded px-2 py-0.5 text-[11px] border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:bg-slate-800"
          >
            按集合查看
          </button>
          {!USE_MOCK_KB ? (
            <button
              type="button"
              disabled={entryManageBusy}
              onClick={() => void deleteTreeDocument(d)}
              className="rounded px-2 py-0.5 text-[11px] border border-rose-500/50 text-rose-400 hover:bg-rose-500/10 disabled:opacity-40"
            >
              删除
            </button>
          ) : null}
        </div>
      </div>
    );
  };

  const renderTreeWorkspace = () => {
    const directCount = treeNodeStats.directCount;
    const subtreeCount = treeNodeStats.subtreeCount;
    const scopeBaseCount =
      treeDocScope === "direct"
        ? directCount
        : treeDocScope === "draft"
          ? treeNodeStats.draftCount
          : treeDocScope === "unclassified"
            ? treeNodeStats.unclassifiedCount
            : subtreeCount;

    return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <KbClassifyRulesHint compact />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              void reloadKbBrowse();
              void reloadBrowseTree();
            }}
            className="rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-1.5 text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:bg-slate-800"
          >
            刷新数据
          </button>
          {unclassifiedCount > 0 ? (
            <button
              type="button"
              onClick={() => {
                setShowUnclassifiedOnly(true);
                handleWorkspaceMode("collections");
              }}
              className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-500/20"
            >
              {unclassifiedCount} 条未完整分类
            </button>
          ) : null}
        </div>
      </div>
    <div className="grid gap-4 lg:grid-cols-12 min-h-[480px]">
      <div className="lg:col-span-3 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-200/40 dark:bg-slate-800/40 p-3 overflow-auto max-h-[70vh]">
        <p className="text-xs text-slate-400 mb-2 font-medium">业务域 / 目录路径</p>
        {treeLoading ? (
          <p className="text-slate-400 text-sm">加载目录树…</p>
        ) : treeError ? (
          <p className="text-amber-400 text-sm">{treeError}</p>
        ) : browseTree.length === 0 ? (
          <div className="space-y-3">
            <p className="text-slate-500 text-sm">
              暂无目录树。条目需在 metadata 中填写 domain 与 folder_path。
            </p>
            <button
              type="button"
              onClick={() => handleWorkspaceMode("collections")}
              className="text-xs text-blue-400 hover:text-blue-300"
            >
              切换到「按集合」浏览 →
            </button>
          </div>
        ) : (
          <TreeNav
            nodes={browseTree}
            depth={0}
            selectedPath={selectedTreeKey}
            onSelect={onTreeSelect}
          />
        )}
        {treeMeta?.truncated ? (
          <p className="text-xs text-amber-400 mt-2">
            已截断（扫描 {treeMeta.entry_count_scanned} 条），可调大 /kb/browse-tree limit。
          </p>
        ) : null}
      </div>
      <div className="lg:col-span-5 flex flex-col rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-200/40 dark:bg-slate-800/40 p-3 max-h-[70vh]">
        <div className="flex flex-wrap gap-2 mb-2 items-center justify-between">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setPreviewMode("summary")}
              className={`rounded px-3 py-1 text-xs ${previewMode === "summary" ? "bg-blue-600" : "bg-slate-300 dark:bg-slate-700"}`}
            >
              摘要列表
            </button>
            <button
              type="button"
              onClick={() => setPreviewMode("markdown")}
              className={`rounded px-3 py-1 text-xs ${previewMode === "markdown" ? "bg-blue-600" : "bg-slate-300 dark:bg-slate-700"}`}
            >
              Markdown
            </button>
          </div>
          <span className="text-xs text-slate-500">
            当前 {displayTreeDocs.length}
            {treeDocQuery || treeDocScope !== "subtree" || displayTreeDocs.length !== filteredTreeDocs.length
              ? ` / ${scopeBaseCount}${displayTreeDocs.length !== filteredTreeDocs.length ? `（chunk ${filteredTreeDocs.length}）` : ""}`
              : ""}{" "}
            篇
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {(
            [
              ["subtree", "含子目录", subtreeCount],
              ["direct", "仅本级", directCount],
              ["draft", "草稿", treeNodeStats.draftCount],
              ["unclassified", "未分类", treeNodeStats.unclassifiedCount],
            ] as const
          ).map(([scope, label, count]) => (
            <button
              key={scope}
              type="button"
              onClick={() => setTreeDocScope(scope)}
              className={`rounded px-2 py-0.5 text-[11px] ${
                treeDocScope === scope
                  ? "bg-blue-600 text-white"
                  : "bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300"
              }`}
            >
              {label} ({count})
            </button>
          ))}
        </div>
        <input
          type="search"
          value={treeDocQuery}
          onChange={(e) => setTreeDocQuery(e.target.value)}
          placeholder="筛选当前节点文档…"
          className="mb-2 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-3 py-1.5 text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500"
        />
        <div className="flex-1 overflow-auto space-y-2">
          {displayTreeDocs.length === 0 ? (
            <p className="text-slate-500 text-sm">
              {subtreeCount === 0 ? "该节点下暂无文档" : "无匹配文档，请调整筛选词"}
            </p>
          ) : previewMode === "summary" ? (
            displayTreeDocs.map((d) => renderTreeDocRow(d))
          ) : (
            <div className="prose prose-invert prose-sm max-w-none">
              {displayTreeDocs.map((d) => {
                const full = entryById.get(d.id);
                const body = full ? fullContent(full) : d.summary || "";
                const md = `# ${d.title}\n\n${body}`;
                return (
                  <div key={d.id} className="mb-6 border-b border-slate-300 dark:border-slate-700 pb-4">
                    <KbMarkdown
                      assetContext={kbAssetContextFromEntry(
                        full ?? { folder_path: d.folder_path },
                      )}
                    >
                      {md}
                    </KbMarkdown>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      <div className="lg:col-span-4 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-200/40 dark:bg-slate-800/40 p-3 overflow-auto max-h-[70vh]">
        <p className="text-xs text-slate-400 mb-3 font-medium">节点管理</p>
        {selectedTreeNode ? (
          <div className="text-sm text-slate-700 dark:text-slate-300 space-y-3">
            <div className="rounded-lg bg-white/90 dark:bg-slate-900/60 p-3 space-y-2">
              <p>
                <span className="text-slate-500">业务域：</span>
                <span className="text-slate-900 dark:text-white">{kbDomainLabel(selectedTreeNode.domain)}</span>
                {selectedTreeNode.domain ? (
                  <span className="ml-1 text-xs text-slate-600 font-mono">
                    ({selectedTreeNode.domain})
                  </span>
                ) : null}
              </p>
              <p>
                <span className="text-slate-500">目录路径：</span>
                <span className="break-all text-slate-900 dark:text-white">
                  {selectedTreeFolderPath || "（域根 · 条目可能无 folder_path）"}
                </span>
              </p>
              <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-xs pt-1 border-t border-slate-300/50 dark:border-slate-700/50">
                <span className="text-slate-500">本级文档</span>
                <span className="text-right text-slate-900 dark:text-white">{directCount}</span>
                <span className="text-slate-500">含子目录</span>
                <span className="text-right text-slate-900 dark:text-white">{subtreeCount}</span>
                <span className="text-slate-500">子文件夹</span>
                <span className="text-right text-slate-900 dark:text-white">{treeNodeStats.childFolderCount}</span>
                <span className="text-slate-500">草稿</span>
                <span className="text-right text-amber-300">{treeNodeStats.draftCount}</span>
                <span className="text-slate-500">未完整分类</span>
                <span className="text-right text-amber-300">{treeNodeStats.unclassifiedCount}</span>
                {treeNodeStats.harvestCount > 0 ? (
                  <>
                    <span className="text-slate-500">对话收割</span>
                    <span className="text-right text-emerald-300">{treeNodeStats.harvestCount}</span>
                  </>
                ) : null}
              </div>
              {treeNodeStats.collectionCounts.length > 0 ? (
                <div className="pt-2 border-t border-slate-300/50 dark:border-slate-700/50">
                  <p className="text-[11px] text-slate-500 mb-1">涉及集合</p>
                  <div className="flex flex-wrap gap-1">
                    {treeNodeStats.collectionCounts.slice(0, 4).map((c) => (
                      <button
                        key={c.name}
                        type="button"
                        title={c.name}
                        onClick={() => jumpToCollectionFromDoc(c.name)}
                        className="rounded px-1.5 py-0.5 text-[10px] bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-700"
                      >
                        {kbCollectionLabel(c.name, { projectNames: projectNameMap })} ({c.count})
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white/80 dark:bg-slate-900/50 p-3 space-y-2">
              <p className="text-[11px] uppercase tracking-wide text-slate-500">导入 / 新建目标</p>
              <label className="block text-xs">
                <span className="text-slate-500">业务域</span>
                <select
                  value={treeTargetDomain}
                  onChange={(e) => setTreeTargetDomain(e.target.value)}
                  className="mt-1 w-full rounded border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-950 px-2 py-1.5 text-sm"
                >
                  {Object.entries(KB_DOMAIN_LABELS)
                    .filter(([k]) => k !== "_uncategorized")
                    .map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                </select>
              </label>
              <label className="block text-xs">
                <span className="text-slate-500">目录路径</span>
                <input
                  value={treeTargetFolderPath}
                  onChange={(e) => setTreeTargetFolderPath(e.target.value)}
                  placeholder="如 02-知识库/子目录"
                  className="mt-1 w-full rounded border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-950 px-2 py-1.5 text-sm font-mono"
                />
              </label>
            </div>

            {(selectedTreeNode.children?.length ?? 0) > 0 ? (
              <div>
                <p className="text-[11px] text-slate-500 mb-1">子目录</p>
                <div className="flex flex-wrap gap-1 max-h-24 overflow-auto">
                  {selectedTreeNode.children!.map((ch, i) => {
                    const key = treeSelectionKey(ch, 1, i);
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => onTreeSelect(key, ch)}
                        className="rounded px-2 py-0.5 text-[11px] border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800"
                      >
                        {ch.segment || "子目录"} ({ch.document_count ?? 0})
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={jumpToIngestFromTree}
                className="rounded-lg bg-emerald-600/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
              >
                导入到此目录
              </button>
              {!USE_MOCK_KB ? (
                <button
                  type="button"
                  onClick={jumpToCreateFromTree}
                  className="rounded-lg bg-blue-600/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
                >
                  新建条目
                </button>
              ) : null}
              <button
                type="button"
                onClick={jumpToCollectionsForNode}
                className="rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-1.5 text-xs text-slate-800 dark:text-slate-200 hover:bg-slate-200 dark:bg-slate-800"
              >
                在集合中管理
              </button>
              <button
                type="button"
                onClick={() => void copyTreeFolderPath()}
                className="rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-1.5 text-xs text-slate-800 dark:text-slate-200 hover:bg-slate-200 dark:bg-slate-800"
              >
                复制路径
              </button>
              {treeNodeStats.draftCount > 0 ? (
                <button
                  type="button"
                  onClick={() => {
                    setTreeDocScope("draft");
                    setTreeDocQuery("");
                  }}
                  className="rounded-lg border border-amber-500/40 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-500/10"
                >
                  查看草稿 ({treeNodeStats.draftCount})
                </button>
              ) : null}
              {treeNodeStats.unclassifiedCount > 0 ? (
                <button
                  type="button"
                  onClick={() => {
                    setTreeDocScope("unclassified");
                    setTreeDocQuery("");
                  }}
                  className="rounded-lg border border-amber-500/40 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-500/10"
                >
                  未分类 ({treeNodeStats.unclassifiedCount})
                </button>
              ) : null}
              {treeNodeStats.harvestCount > 0 ? (
                <button
                  type="button"
                  onClick={() => handleWorkspaceMode("harvest")}
                  className="rounded-lg border border-emerald-500/40 px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-500/10"
                >
                  对话收割 ({treeNodeStats.harvestCount})
                </button>
              ) : null}
            </div>
            {nodeManageMessage ? (
              <p className="text-[11px] text-slate-500">{nodeManageMessage}</p>
            ) : null}
          </div>
        ) : (
          <p className="text-slate-500 text-sm">选择左侧节点</p>
        )}
        {selectedEntry ? (
          <div className="mt-4 border-t border-slate-300 dark:border-slate-700 pt-4">
            <p className="text-xs uppercase text-slate-500 mb-2">选中条目</p>
            <p className="font-medium text-slate-900 dark:text-white">{selectedEntry.title}</p>
            <p className="text-xs text-slate-500 mt-1">
              {kbDomainLabel(selectedEntry.domain)} · {selectedEntry.folder_path || "—"}
            </p>
            <p className="text-xs text-slate-500 mt-1">
              {kbCollectionLabel(selectedEntry.collection, { projectNames: projectNameMap })}
            </p>
          </div>
        ) : null}
      </div>
    </div>
    </div>
    );
  };

  const renderBrowseEntryRow = (entry: KBEntry) => {
    const classify = entryClassifyStatus(entry);
    return (
      <div
        key={entry.id}
        onClick={() => handleEntryClick(entry)}
        className={`bg-slate-200/60 dark:bg-slate-800/60 border rounded-xl p-5 cursor-pointer transition ${
          selectedEntry?.id === entry.id
            ? "border-blue-500 bg-slate-300/60 dark:bg-slate-700/60"
            : "border-slate-300 dark:border-slate-700 hover:bg-slate-300/40 dark:bg-slate-700/40 hover:border-slate-300 dark:border-slate-600"
        }`}
      >
        <div className="flex items-start justify-between mb-2 gap-2 flex-wrap">
          <h3 className="text-lg font-semibold text-slate-900 dark:text-white">{entry.title}</h3>
          <span className="flex flex-wrap gap-1 justify-end">
            {workspaceMode !== "harvest" ? (
              <span
                className={`text-[10px] px-2 py-1 rounded ${
                  classify.ok
                    ? "bg-emerald-500/15 text-emerald-300"
                    : "bg-amber-500/15 text-amber-200"
                }`}
                title={classify.hint}
              >
                {classify.label}
              </span>
            ) : null}
            {entry.source_type === "conversation_harvest" && entry.published === false ? (
              <span className="text-xs bg-amber-500/25 text-amber-200 px-2 py-1 rounded">
                待审核
              </span>
            ) : null}
            {entry.source_type && workspaceMode !== "harvest" ? (
              <span
                className="text-xs font-semibold text-emerald-800 dark:text-emerald-100 bg-emerald-500/25 dark:bg-emerald-500/30 px-2.5 py-1 rounded-md shrink-0 border border-emerald-500/30"
                title={entry.source_type}
              >
                {kbSourceTypeLabel(entry.source_type)}
              </span>
            ) : null}
            <span
              className="text-xs text-slate-400 bg-slate-300 dark:bg-slate-700 px-2 py-1 rounded shrink-0 max-w-[180px] truncate"
              title={entry.collection}
            >
              {kbCollectionLabel(entry.collection, { projectNames: projectNameMap })}
            </span>
          </span>
        </div>
        <p className="text-slate-400 text-sm mb-3 line-clamp-2">{entry.summary}</p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span>来源：{entry.source}</span>
          <span>·</span>
          <span>{formatDate(entry.created_at)}</span>
          {workspaceMode !== "harvest" ? (
            <>
              <span>·</span>
              <span>{kbDomainLabel(entry.domain)}</span>
              {entry.folder_path ? (
                <>
                  <span>·</span>
                  <span className="truncate max-w-[240px]" title={entry.folder_path}>
                    {entry.folder_path}
                  </span>
                </>
              ) : null}
            </>
          ) : (
            <>
              <span>·</span>
              <span>{entry.published === false ? "草稿" : "已发布"}</span>
            </>
          )}
          {entry.projects.length > 0 && (
            <>
              <span>·</span>
              <span>关联 {entry.projects.length} 个项目</span>
            </>
          )}
        </div>
        {workspaceMode !== "harvest" && !classify.ok ? (
          <div className="mt-3 flex flex-wrap gap-2" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => {
                setIngestDomain(
                  entry.domain && entry.domain !== "_uncategorized"
                    ? entry.domain
                    : "structured_tech",
                );
                setIngestFolderPath(entry.folder_path || "02-知识库/导入");
                setIngestCollection(entry.collection);
                handleWorkspaceMode("ingest");
              }}
              className="rounded px-2 py-1 text-[11px] bg-emerald-600/80 text-white hover:bg-emerald-500"
            >
              补全分类（导入）
            </button>
          </div>
        ) : null}
      </div>
    );
  };

  const renderHarvestWorkspace = () => {
    const rows =
      harvestVisibleEntries.length > 0
        ? harvestVisibleEntries
        : USE_MOCK_KB
          ? MOCK_ENTRIES.filter((e) => e.source_type === "conversation_harvest")
          : [];

    return (
      <div>
        {kbLoadError && (
          <p className="text-sm text-amber-400 mb-3">
            知识库数据加载异常：{kbLoadError}
          </p>
        )}
        <div className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-100/90">
          <p className="font-medium text-emerald-200">对话收割审核队列</p>
          <p className="text-xs text-slate-400 mt-1">
            来自工坊「存入知识库」的摘录，默认草稿未发布。点击条目在详情面板审核发布。
          </p>
        </div>
        <div className="flex flex-wrap gap-2 mb-4 items-center">
          <button
            type="button"
            onClick={() => void reloadKbBrowse()}
            className="rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-1.5 text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:bg-slate-800"
          >
            刷新
          </button>
          {(
            [
              ["draft", "待审核", harvestStats.draft],
              ["published", "已发布", harvestStats.published],
              ["all", "全部", harvestStats.total],
            ] as const
          ).map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                setHarvestPublishFilter(key);
                setPage(0);
              }}
              className={`px-4 py-2 rounded-lg text-sm border transition ${
                harvestPublishFilter === key
                  ? key === "draft"
                    ? "bg-amber-600/80 border-amber-500 text-white"
                    : "bg-blue-600 border-blue-500 text-white"
                  : "bg-slate-200 dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:bg-slate-700"
              }`}
            >
              {label} ({count})
            </button>
          ))}
        </div>
        {entryManageMessage ? (
          <p className="text-xs text-amber-200/90 mb-3 whitespace-pre-wrap">{entryManageMessage}</p>
        ) : null}
        <div className="space-y-3">
          {rows.length === 0 && (
            <p className="text-slate-500 text-center py-12 text-sm">
              {harvestStats.total === 0
                ? "暂无对话收割条目。请在工坊对话中点击「存入知识库」。"
                : harvestPublishFilter === "draft"
                  ? "没有待审核草稿，可查看「已发布」或「全部」。"
                  : "当前筛选下无条目。"}
            </p>
          )}
          {rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((entry) =>
            renderBrowseEntryRow(entry),
          )}
        </div>
        {rows.length > PAGE_SIZE && (
          <div className="flex justify-center gap-3 mt-6">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-4 py-2 bg-slate-200 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-sm hover:bg-slate-300 dark:bg-slate-700 disabled:opacity-40"
            >
              上一页
            </button>
            <span className="px-4 py-2 text-slate-400 text-sm">第 {page + 1} 页</span>
            <button
              type="button"
              onClick={() =>
                setPage((p) => ((p + 1) * PAGE_SIZE < rows.length ? p + 1 : p))
              }
              disabled={(page + 1) * PAGE_SIZE >= rows.length}
              className="px-4 py-2 bg-slate-200 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-sm hover:bg-slate-300 dark:bg-slate-700 disabled:opacity-40"
            >
              下一页
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderCollectionWorkspace = () => {
    const cols = collections.length > 0 ? collections : MOCK_COLLECTIONS;
    const publicCols = cols.filter((c) => isPublicKbCollection(c.name));
    const otherCols = cols.filter((c) => !isPublicKbCollection(c.name));
    const rawRows =
      visibleBrowseEntries.length > 0
        ? visibleBrowseEntries
        : USE_MOCK_KB
          ? MOCK_ENTRIES
          : [];
    const rows = dedupeKbEntriesByDocId(rawRows);

    const renderColButton = (col: Collection) => {
      const label = kbCollectionLabel(col.name, { projectNames: projectNameMap });
      const active = filterCollection === col.name;
      return (
        <button
          type="button"
          key={col.name}
          onClick={() => {
            setFilterCollection((prev) => (prev === col.name ? null : col.name));
            setShowUnclassifiedOnly(false);
            setPage(0);
          }}
          className={`px-4 py-2 rounded-lg text-sm border transition text-left ${
            active
              ? "bg-blue-600 border-blue-500 text-white"
              : "bg-slate-200 dark:bg-slate-800 border-slate-300 dark:border-slate-700 hover:bg-slate-300 dark:bg-slate-700"
          }`}
          title={col.name}
        >
          <span className="block font-medium text-slate-900 dark:text-white">{label}</span>
          <span className="text-slate-400 text-xs font-mono">{col.name}</span>
          <span className="ml-0 mt-0.5 block text-slate-400 text-xs">({col.entry_count} 条)</span>
        </button>
      );
    };

    const renderColOption = (col: Collection) => {
      const label = kbCollectionLabel(col.name, { projectNames: projectNameMap });
      return (
        <option key={col.name} value={col.name} title={col.name}>
          {label} ({col.entry_count} 条)
        </option>
      );
    };

    const otherColNames = new Set(otherCols.map((c) => c.name));
    const selectedOtherCollection =
      filterCollection && otherColNames.has(filterCollection) ? filterCollection : "";

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
        {treeNodeDocFilter ? (
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs text-blue-200">
            <span>目录节点筛选：共 {visibleBrowseEntries.length} 条</span>
            <button
              type="button"
              onClick={() => setTreeNodeDocFilter(null)}
              className="rounded border border-blue-400/40 px-2 py-0.5 hover:bg-blue-500/20"
            >
              清除筛选
            </button>
            <button
              type="button"
              onClick={() => handleWorkspaceMode("tree")}
              className="rounded border border-blue-400/40 px-2 py-0.5 hover:bg-blue-500/20"
            >
              返回目录树
            </button>
          </div>
        ) : null}
        <div className="mb-4">
          <KbClassifyRulesHint compact />
        </div>
        <div className="flex flex-wrap gap-2 mb-4 items-center">
          <button
            type="button"
            onClick={() => void reloadKbBrowse()}
            className="rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-1.5 text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:bg-slate-800"
          >
            刷新
          </button>
          <button
            type="button"
            onClick={() => {
              setFilterCollection(null);
              setShowUnclassifiedOnly(false);
            }}
            className={`px-4 py-2 rounded-lg text-sm border transition ${
              filterCollection === null && !showUnclassifiedOnly
                ? "bg-blue-600 border-blue-500 text-white"
                : "bg-slate-200 dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:bg-slate-700"
            }`}
          >
            全部 ({browseEntries.length})
          </button>
          {unclassifiedCount > 0 ? (
            <button
              type="button"
              onClick={() => {
                setShowUnclassifiedOnly((v) => !v);
                setFilterCollection(null);
                setPage(0);
              }}
              className={`px-4 py-2 rounded-lg text-sm border transition ${
                showUnclassifiedOnly
                  ? "bg-amber-600/80 border-amber-500 text-white"
                  : "bg-slate-200 dark:bg-slate-800 border-amber-700/50 text-amber-200 hover:bg-amber-900/30"
              }`}
            >
              未完整分类 ({unclassifiedCount})
            </button>
          ) : null}
        </div>
        {publicCols.length > 0 ? (
          <div className="mb-4">
            <p className="text-xs text-slate-500 mb-2 uppercase tracking-wide">公共知识库</p>
            <div className="flex gap-2 flex-wrap">{publicCols.map(renderColButton)}</div>
          </div>
        ) : null}
        {otherCols.length > 0 ? (
          <div className="mb-6">
            <label
              htmlFor="kb-collection-select"
              className="mb-1.5 block text-xs text-slate-500 uppercase tracking-wide"
            >
              其他集合
            </label>
            <select
              id="kb-collection-select"
              value={showUnclassifiedOnly ? "" : selectedOtherCollection}
              disabled={showUnclassifiedOnly}
              onChange={(e) => {
                const v = e.target.value;
                setFilterCollection(v || null);
                setShowUnclassifiedOnly(false);
                setPage(0);
              }}
              className="w-full max-w-md rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="">请选择集合…</option>
              {otherCols.map(renderColOption)}
            </select>
          </div>
        ) : publicCols.length === 0 ? (
          <div className="mb-6">
            <label
              htmlFor="kb-collection-select"
              className="mb-1.5 block text-xs text-slate-500 uppercase tracking-wide"
            >
              知识集合
            </label>
            <select
              id="kb-collection-select"
              value={showUnclassifiedOnly ? "" : filterCollection ?? ""}
              disabled={showUnclassifiedOnly}
              onChange={(e) => {
                const v = e.target.value;
                setFilterCollection(v || null);
                setShowUnclassifiedOnly(false);
                setPage(0);
              }}
              className="w-full max-w-md rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="">请选择集合…</option>
              {cols.map(renderColOption)}
            </select>
          </div>
        ) : null}
        {workspaceMode === "collections" ? (
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <span className="text-xs text-slate-400">知识点来源：</span>
            <select
              value={filterSourceType}
              onChange={(ev) =>
                setFilterSourceType(ev.target.value as SourceTypeFilter)
              }
              className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 text-sm px-3 py-1.5 text-slate-800 dark:text-slate-200"
            >
              <option value="all">全部</option>
              <option value="conversation_harvest">对话收割</option>
              <option value="file">文件导入</option>
              <option value="upload">上传导入</option>
            </select>
            {filterCollection ? (
              <>
                <button
                  type="button"
                  onClick={() => handleWorkspaceMode("tree")}
                  className="text-xs text-blue-400 hover:text-blue-300"
                >
                  在目录树中浏览 →
                </button>
                {!USE_MOCK_KB ? (
                  <button
                    type="button"
                    disabled={entryManageBusy}
                    onClick={() => {
                      const col = cols.find((c) => c.name === filterCollection);
                      void deleteCollectionAll(
                        filterCollection,
                        kbCollectionLabel(filterCollection, { projectNames: projectNameMap }),
                        col?.entry_count ?? rows.length,
                      );
                    }}
                    className="rounded-lg border border-rose-500/50 px-3 py-1.5 text-xs text-rose-400 hover:bg-rose-500/10 disabled:opacity-40"
                  >
                    删除此合集全部
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
        {entryManageMessage && workspaceMode === "collections" ? (
          <p className="text-xs text-amber-200/90 mb-3 whitespace-pre-wrap">{entryManageMessage}</p>
        ) : null}
        <div className="space-y-3">
          {rows.length === 0 && (
            <p className="text-slate-500 text-center py-8 text-sm">
              {showUnclassifiedOnly
                ? "所有条目均已填写 domain 与 folder_path。"
                : "暂无条目。可在外部 KB 同步后刷新，或切换到「检索验证」。"}
            </p>
          )}
          {rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((entry) =>
            renderBrowseEntryRow(entry),
          )}
        </div>
        {rows.length > PAGE_SIZE && (
          <div className="flex justify-center gap-3 mt-6">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-4 py-2 bg-slate-200 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-sm hover:bg-slate-300 dark:bg-slate-700 disabled:opacity-40"
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
              className="px-4 py-2 bg-slate-200 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-sm hover:bg-slate-300 dark:bg-slate-700 disabled:opacity-40"
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
          className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-white min-w-[200px]"
        >
          <option value="">全部 collection</option>
          {(collections.length ? collections : MOCK_COLLECTIONS).map((c) => (
            <option key={c.name} value={c.name}>
              {kbCollectionLabel(c.name, { projectNames: projectNameMap })}
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
          className="flex-1 px-4 py-3 bg-slate-200 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:border-blue-500"
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
              className={`bg-slate-200/60 dark:bg-slate-800/60 border rounded-xl p-5 cursor-pointer transition ${
                selectedEntry?.id === entry.id
                  ? "border-blue-500 bg-slate-300/60 dark:bg-slate-700/60"
                  : "border-slate-300 dark:border-slate-700 hover:bg-slate-300/40 dark:bg-slate-700/40"
              }`}
            >
              <div className="flex items-start justify-between mb-2">
                <h3 className="text-lg font-semibold text-slate-900 dark:text-white">{entry.title}</h3>
                <span className="text-xs text-slate-500 bg-slate-300 dark:bg-slate-700 px-2 py-1 rounded">
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
              {!USE_MOCK_KB ? (
                <div className="mt-3" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    disabled={entryManageBusy}
                    onClick={() => void deleteKbDocument(entry, entry.title)}
                    className="rounded px-2 py-1 text-[11px] border border-rose-500/50 text-rose-400 hover:bg-rose-500/10 disabled:opacity-40"
                  >
                    删除知识点
                  </button>
                </div>
              ) : null}
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
            className="rounded-lg bg-slate-300 dark:bg-slate-700 px-4 py-2 text-sm"
          >
            刷新统计
          </button>
          <button
            type="button"
            disabled={kgBusy}
            onClick={() => void runKgValidate()}
            className="rounded-lg bg-slate-300 dark:bg-slate-700 px-4 py-2 text-sm"
          >
            校验一致性
          </button>
          <button
            type="button"
            disabled={kgBusy}
            onClick={() => void loadKgNodes()}
            className="rounded-lg bg-slate-300 dark:bg-slate-700 px-4 py-2 text-sm"
          >
            加载节点
          </button>
          <button
            type="button"
            disabled={kgBusy}
            onClick={() => void loadKgRels()}
            className="rounded-lg bg-slate-300 dark:bg-slate-700 px-4 py-2 text-sm"
          >
            加载关系
          </button>
          <button
            type="button"
            disabled={kgBusy}
            onClick={() => void doKgExport()}
            className="rounded-lg border border-slate-300 dark:border-slate-600 px-4 py-2 text-sm"
          >
            导出数据
          </button>
        </div>
        {nodesBlock ? (
          <div className="grid gap-3 sm:grid-cols-5">
            {Object.entries(nodesBlock).map(([k, v]) => (
              <div key={k} className="rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-200 dark:bg-slate-800/50 p-3">
                <p className="text-xs text-slate-500">{k}</p>
                <p className="text-xl font-semibold text-slate-900 dark:text-white">{v}</p>
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
            <p className="font-medium text-slate-900 dark:text-white mb-2">
              校验：{kgValidate.ok ? "通过" : `问题 ${kgValidate.errors.length} 条`}
            </p>
            <ul className="list-disc pl-5 text-slate-700 dark:text-slate-300 max-h-40 overflow-auto">
              {kgValidate.errors.slice(0, 30).map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div>
          <p className="text-sm text-slate-400 mb-2">
            批量导入（品牌、车型、技术洞察、规划车型、核心技术及关系等结构化字段）
          </p>
          <textarea
            value={kgImportText}
            onChange={(e) => setKgImportText(e.target.value)}
            className="w-full h-40 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 p-3 text-sm text-slate-800 dark:text-slate-200 font-mono"
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
                className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-white"
              >
                {KG_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {kgKindLabel(k)}
                  </option>
                ))}
              </select>
            </div>
            <div className="max-h-64 overflow-auto rounded-lg border border-slate-300 dark:border-slate-700">
              <table className="w-full text-left text-xs text-slate-700 dark:text-slate-300">
                <tbody>
                  {kgNodes.map((row, i) => (
                    <tr key={i} className="border-b border-slate-200 dark:border-slate-800">
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
                className="rounded border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-2 py-1 text-sm"
                placeholder="关系类型，如 HAS_INSIGHT"
                value={relForm.rel_type}
                onChange={(e) =>
                  setRelForm((f) => ({ ...f, rel_type: e.target.value }))
                }
              />
              <input
                className="rounded border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-2 py-1 text-sm"
                placeholder="源实体类型，如 Vehicle"
                value={relForm.src_kind}
                onChange={(e) =>
                  setRelForm((f) => ({ ...f, src_kind: e.target.value }))
                }
              />
              <input
                className="rounded border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-2 py-1 text-sm"
                placeholder="源实体 ID"
                value={relForm.src_id}
                onChange={(e) =>
                  setRelForm((f) => ({ ...f, src_id: e.target.value }))
                }
              />
              <input
                className="rounded border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-2 py-1 text-sm"
                placeholder="目标实体类型"
                value={relForm.dst_kind}
                onChange={(e) =>
                  setRelForm((f) => ({ ...f, dst_kind: e.target.value }))
                }
              />
              <input
                className="rounded border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-2 py-1 text-sm"
                placeholder="目标实体 ID"
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
            setIngestMessage("上传 ID 映射须为「上传 ID → 文档 ID」的 JSON 对象");
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
          typeof report.status === "string"
            ? `任务状态：${runStatusLabel(report.status)}`
            : "导入已完成",
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
        setIngestMessage(`任务 ${ingestJobId}：${runStatusLabel(row.status)}`);
      } catch (e) {
        setIngestMessage(e instanceof Error ? e.message : "查询任务失败");
      }
    };

    return (
      <div className="space-y-6 max-w-3xl">
        <p className="text-sm text-slate-400">
          上传 Markdown / 纯文本 → 写入外部 Chroma → 同步 kb_cache。需后端可访问{" "}
          外部向量库服务。
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="text-slate-400">知识集合</span>
            <input
              value={ingestCollection}
              onChange={(e) => setIngestCollection(e.target.value)}
              placeholder="如：public.structured_tech.topic"
              className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="text-slate-400">业务域</span>
            <input
              value={ingestDomain}
              onChange={(e) => setIngestDomain(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="text-slate-400">目录路径</span>
            <input
              value={ingestFolderPath}
              onChange={(e) => setIngestFolderPath(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="text-slate-400">缓存同步项目 ID</span>
            <input
              value={ingestProjectId}
              onChange={(e) => setIngestProjectId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="text-slate-400">上传时文档 ID（可选，写入服务器）</span>
            <input
              value={ingestDocIdOnUpload}
              onChange={(e) => setIngestDocIdOnUpload(e.target.value)}
              placeholder="稳定文档 ID，幂等更新 / publish"
              className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="text-slate-400">默认 doc_id 策略（无显式 doc_id 时）</span>
            <select
              value={ingestDocIdStrategy}
              onChange={(e) =>
                setIngestDocIdStrategy(e.target.value === "checksum" ? "checksum" : "filename")
              }
              className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm"
            >
              <option value="filename">原文件名 stem</option>
              <option value="checksum">sha256 前缀（跨重命名稳定）</option>
            </select>
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="text-slate-400">导入时上传 ID → 文档 ID 映射（JSON 可选）</span>
            <input
              value={ingestUploadDocIdsJson}
              onChange={(e) => setIngestUploadDocIdsJson(e.target.value)}
              placeholder='{"uuid-1":"my_doc_a"}'
              className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm font-mono"
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
            className="block w-full text-sm text-slate-700 dark:text-slate-300"
          />
          {ingestUploadIds.length > 0 ? (
            <p className="text-xs text-slate-500 mt-2">
              已选上传 ID：{ingestUploadIds.join(", ")}
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
            className="rounded-lg border border-slate-300 dark:border-slate-600 px-4 py-2 text-sm text-slate-800 dark:text-slate-200 disabled:opacity-40"
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
            className="rounded-lg border border-slate-300 dark:border-slate-600 px-4 py-2 text-sm text-slate-800 dark:text-slate-200"
          >
            清空队列
          </button>
        </div>
        {ingestMessage ? (
          <p className="text-sm text-amber-200/90 whitespace-pre-wrap">{ingestMessage}</p>
        ) : null}
        {ingestJobView ? (
          <pre className="text-xs bg-slate-100 dark:bg-slate-950/80 border border-slate-200 dark:border-slate-800 rounded-lg p-3 overflow-auto max-h-64 text-slate-700 dark:text-slate-300">
            {JSON.stringify(ingestJobView, null, 2)}
          </pre>
        ) : null}
      </div>
    );
  };

  const renderCreateEntryPanel = () => {
    if (!showCreateEntry || USE_MOCK_KB) return null;
    const colOptions = collections.length > 0 ? collections : MOCK_COLLECTIONS;
    return (
      <div className="mb-6 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-emerald-200">新建知识条目</p>
          <button
            type="button"
            onClick={() => setShowCreateEntry(false)}
            className="text-slate-400 hover:text-slate-900 dark:hover:text-white text-lg leading-none"
          >
            ×
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm sm:col-span-2">
            <span className="text-slate-400">知识集合</span>
            <select
              value={createEntryForm.collection}
              onChange={(e) =>
                setCreateEntryForm((f) => ({ ...f, collection: e.target.value }))
              }
              className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm"
            >
              <option value="">选择集合…</option>
              {colOptions.map((c) => (
                <option key={c.name} value={c.name}>
                  {kbCollectionLabel(c.name, { projectNames: projectNameMap })}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="text-slate-400">标题</span>
            <input
              value={createEntryForm.title}
              onChange={(e) =>
                setCreateEntryForm((f) => ({ ...f, title: e.target.value }))
              }
              className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="text-slate-400">业务域</span>
            <select
              value={createEntryForm.domain}
              onChange={(e) =>
                setCreateEntryForm((f) => ({ ...f, domain: e.target.value }))
              }
              className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm"
            >
              {Object.entries(KB_DOMAIN_LABELS)
                .filter(([k]) => k !== "_uncategorized")
                .map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-slate-400">目录路径</span>
            <input
              value={createEntryForm.folder_path}
              onChange={(e) =>
                setCreateEntryForm((f) => ({ ...f, folder_path: e.target.value }))
              }
              className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="text-slate-400">文档 ID（可选）</span>
            <input
              value={createEntryForm.doc_id}
              onChange={(e) =>
                setCreateEntryForm((f) => ({ ...f, doc_id: e.target.value }))
              }
              placeholder="留空则自动生成"
              className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm font-mono"
            />
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="text-slate-400">正文（Markdown）</span>
            <textarea
              value={createEntryForm.content}
              onChange={(e) =>
                setCreateEntryForm((f) => ({ ...f, content: e.target.value }))
              }
              rows={8}
              className="mt-1 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm font-mono"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              checked={createEntryForm.published}
              onChange={(e) =>
                setCreateEntryForm((f) => ({ ...f, published: e.target.checked }))
              }
            />
            创建后立即发布
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={entryManageBusy}
            onClick={() => void createManualEntry()}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white disabled:opacity-40"
          >
            {entryManageBusy ? "提交中…" : "创建条目"}
          </button>
        </div>
      </div>
    );
  };

  const renderDetailPanel = (entry: KBEntry) => {
    const fromEntry = entryById.get(entry.id) ?? entry;
    const projectId =
      fromEntry.projects[0] != null ? String(fromEntry.projects[0]) : "__all__";
    const mdBody = fullContent(entry);

    const docId = resolveDocId(fromEntry);

    return (
      <div className="bg-slate-200/60 dark:bg-slate-800/60 border border-blue-500 rounded-xl p-6 mt-4">
        <div className="flex items-start justify-between mb-4 gap-2 flex-wrap">
          <div className="flex flex-col gap-1">
            <h3 className="text-xl font-bold text-slate-900 dark:text-white">{entry.title}</h3>
            <div className="flex gap-2 flex-wrap">
              {entry.source_type === "conversation_harvest" &&
              entry.published === false ? (
                <span className="text-xs px-2 py-0.5 rounded bg-amber-500/25 text-amber-100 border border-amber-500/30">
                  待审核 · 草稿
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!USE_MOCK_KB && docId ? (
              <>
                {entryEditing ? (
                  <>
                    <button
                      type="button"
                      disabled={entryManageBusy}
                      onClick={() => void saveEntryEdit()}
                      className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-40"
                    >
                      {entryManageBusy ? "保存中…" : "保存"}
                    </button>
                    <button
                      type="button"
                      disabled={entryManageBusy}
                      onClick={() => {
                        setEntryEditing(false);
                        setEntryEditForm(entryEditFormFrom(fromEntry, mdBody));
                      }}
                      className="rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-1.5 text-sm text-slate-700 dark:text-slate-300"
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setEntryEditing(true)}
                    className="rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-1.5 text-sm text-slate-800 dark:text-slate-200 hover:bg-slate-200 dark:bg-slate-800"
                  >
                    编辑
                  </button>
                )}
                <button
                  type="button"
                  disabled={entryManageBusy}
                  onClick={() => void deleteSelectedEntry()}
                  className="rounded-lg border border-rose-500/50 px-3 py-1.5 text-sm text-rose-300 hover:bg-rose-500/10 disabled:opacity-40"
                >
                  删除
                </button>
              </>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setSelectedEntry(null);
                setEntryEditing(false);
              }}
              className="text-slate-400 hover:text-slate-900 dark:hover:text-white text-xl leading-none"
            >
              ×
            </button>
          </div>
        </div>
        {entryManageMessage ? (
          <p className="text-xs text-amber-200/90 mb-3 whitespace-pre-wrap">{entryManageMessage}</p>
        ) : null}
        <div className="space-y-4">
          {entryEditing ? (
            <div className="rounded-lg border border-slate-300 dark:border-slate-600 bg-slate-100 dark:bg-slate-900/70 p-4 space-y-3">
              <p className="text-xs uppercase text-slate-500">编辑条目</p>
              <label className="block text-sm">
                <span className="text-slate-400">标题</span>
                <input
                  value={entryEditForm.title}
                  onChange={(e) =>
                    setEntryEditForm((f) => ({ ...f, title: e.target.value }))
                  }
                  className="mt-1 w-full rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm"
                />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className="text-slate-400">业务域</span>
                  <select
                    value={entryEditForm.domain}
                    onChange={(e) =>
                      setEntryEditForm((f) => ({ ...f, domain: e.target.value }))
                    }
                    className="mt-1 w-full rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm"
                  >
                    {Object.entries(KB_DOMAIN_LABELS)
                      .filter(([k]) => k !== "_uncategorized")
                      .map(([k, label]) => (
                        <option key={k} value={k}>
                          {label}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="text-slate-400">目录路径</span>
                  <input
                    value={entryEditForm.folder_path}
                    onChange={(e) =>
                      setEntryEditForm((f) => ({ ...f, folder_path: e.target.value }))
                    }
                    className="mt-1 w-full rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm"
                  />
                </label>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={entryEditForm.published}
                  onChange={(e) =>
                    setEntryEditForm((f) => ({ ...f, published: e.target.checked }))
                  }
                />
                已发布（对外可见）
              </label>
              <label className="block text-sm">
                <span className="text-slate-400">正文（Markdown）</span>
                <textarea
                  value={entryEditForm.content}
                  onChange={(e) =>
                    setEntryEditForm((f) => ({ ...f, content: e.target.value }))
                  }
                  rows={12}
                  className="mt-1 w-full rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm font-mono"
                />
              </label>
              {docId ? (
                <p className="text-xs text-slate-600 font-mono">doc_id: {docId}</p>
              ) : null}
            </div>
          ) : null}
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">来源</p>
            <p className="text-slate-700 dark:text-slate-300">{entry.source}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">域 / 路径</p>
            <p className="text-slate-700 dark:text-slate-300 text-sm">
              {kbDomainLabel(entry.domain)}
              {entry.domain ? (
                <span className="text-slate-600 font-mono text-xs ml-1">({entry.domain})</span>
              ) : null}
              {entry.folder_path ? ` · ${entry.folder_path}` : ""}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">发布</p>
            <p className="text-slate-700 dark:text-slate-300 text-sm">
              {entry.published === false ? "否（仅治理）" : "是 / 未标注"}
            </p>
          </div>
          {entry.doc_id ? (
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">{fieldLabel("doc_id")}</p>
              <p className="text-slate-700 dark:text-slate-300 font-mono text-xs break-all">{entry.doc_id}</p>
            </div>
          ) : null}
          {entry.source_type ? (
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">{fieldLabel("source_type")}</p>
              <p className="text-slate-700 dark:text-slate-300 text-sm">{kbSourceTypeLabel(entry.source_type)}</p>
            </div>
          ) : null}
          {entry.conversation_id ? (
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">{fieldLabel("conversation_id")}</p>
              <p className="text-slate-700 dark:text-slate-300 text-sm font-mono break-all">{entry.conversation_id}</p>
            </div>
          ) : null}
          {entry.confidence !== undefined && entry.confidence !== null && entry.confidence !== "" ? (
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">{fieldLabel("confidence")}</p>
              <p className="text-slate-700 dark:text-slate-300 text-sm">{String(entry.confidence)}</p>
            </div>
          ) : null}
          {entry.harvested_from_user_confirmed !== undefined ? (
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">
                {fieldLabel("harvested_from_user_confirmed")}
              </p>
              <p className="text-slate-700 dark:text-slate-300 text-sm">
                {entry.harvested_from_user_confirmed ? "是" : "否"}
              </p>
            </div>
          ) : null}
          {entry.source_type === "conversation_harvest" && entry.doc_id ? (
            <div className="rounded-lg border border-slate-300 dark:border-slate-600 bg-slate-100 dark:bg-slate-900/70 p-3">
              <p className="text-xs uppercase text-slate-500 mb-2">草稿审核</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={USE_MOCK_KB || publishBusy}
                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    void publishHarvestEntry(fromEntry, true);
                  }}
                >
                  {publishBusy ? "处理中…" : "发布后可见"}
                </button>
                <button
                  type="button"
                  disabled={USE_MOCK_KB || publishBusy || entry.published === false}
                  className={`rounded-lg border px-3 py-1.5 text-sm disabled:opacity-40 ${
                    entry.published === false
                      ? "border-slate-300 dark:border-slate-700 text-slate-500 cursor-not-allowed"
                      : "border-slate-300 dark:border-slate-600 text-slate-800 dark:text-slate-200 hover:bg-slate-200 dark:bg-slate-800"
                  }`}
                  title={entry.published === false ? "当前已是草稿" : "恢复为草稿态"}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    if (entry.published === false) return;
                    void publishHarvestEntry(fromEntry, false);
                  }}
                >
                  降为草稿
                </button>
              </div>
              {publishMessage ? (
                <p className="text-xs text-slate-400 mt-2">{publishMessage}</p>
              ) : null}
              <p className="text-xs text-slate-600 mt-2">
                通过知识库发布接口同步，当前项目 ID：{projectId}
              </p>
            </div>
          ) : null}
          {!entryEditing ? (
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">正文预览</p>
            <div className="prose prose-invert prose-sm max-w-none text-slate-700 dark:text-slate-300">
              <KbMarkdown assetContext={kbAssetContextFromEntry(fromEntry)}>
                {mdBody || "—"}
              </KbMarkdown>
            </div>
          </div>
          ) : null}
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">{fieldLabel("collection")}</p>
            <p className="text-slate-700 dark:text-slate-300">{kbCollectionLabel(entry.collection, { projectNames: projectNameMap })}</p>
            <p className="text-xs text-slate-600 font-mono mt-0.5">{entry.collection}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">关联图谱 ID（元数据）</p>
            <p className="text-slate-700 dark:text-slate-300 text-sm font-mono">
              {entry.linked_kg_ids?.length
                ? entry.linked_kg_ids.join(", ")
                : "—"}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide mb-2">
              图谱关联
            </p>
            <div className="flex gap-2 flex-wrap mb-2">
              <select
                value={kgLinkKind}
                onChange={(e) => setKgLinkKind(e.target.value)}
                className="rounded border border-slate-300 dark:border-slate-600 bg-slate-100 dark:bg-slate-900 text-sm px-2 py-1"
              >
                {KG_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {kgKindLabel(k)}
                  </option>
                ))}
              </select>
              <input
                value={kgLinkNodeId}
                onChange={(e) => setKgLinkNodeId(e.target.value)}
                placeholder="节点 ID"
                className="rounded border border-slate-300 dark:border-slate-600 bg-slate-100 dark:bg-slate-900 text-sm px-2 py-1 flex-1 min-w-[120px]"
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
            <p className="text-xs text-slate-600 mt-2">当前项目 ID：{projectId}</p>
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
    <main className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100 p-4 text-slate-900 sm:p-6 md:p-8 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 dark:text-white">
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
                公共知识库：<strong className="text-slate-800 dark:text-slate-200">目录树</strong>治理与{" "}
                <strong className="text-slate-800 dark:text-slate-200">知识图谱</strong>
                信息点；执行侧仍只消费场景{" "}
                场景合同中的知识集合配置。
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link
                href="/projects"
                className="rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900/70 px-4 py-2.5 text-sm font-medium text-slate-800 dark:text-slate-200 transition hover:border-slate-300 dark:border-slate-600"
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

        <section id="kb-workspace" className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/50 p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">知识工作台</p>
              <h2 className="mt-2 text-xl font-semibold text-slate-900 dark:text-white">目录 · 集合 · 检索 · 图谱 · 导入</h2>
            </div>
            <div className="flex flex-wrap gap-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-200/60 dark:bg-slate-800/60 p-1">
              {(
                [
                  ["tree", "目录浏览"],
                  ["collections", "按集合"],
                  ["harvest", "对话收割"],
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
                      : "text-slate-400 hover:text-slate-900 dark:hover:text-white"
                  }`}
                >
                  {label}
                </button>
              ))}
              {!USE_MOCK_KB ? (
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateEntry((v) => !v);
                    setEntryManageMessage(null);
                    const firstCol =
                      (collections.length ? collections : MOCK_COLLECTIONS)[0]?.name ?? "";
                    if (firstCol && !createEntryForm.collection) {
                      setCreateEntryForm((f) => ({ ...f, collection: firstCol }));
                    }
                  }}
                  className={`rounded-md px-4 py-2 text-sm font-medium transition ${
                    showCreateEntry
                      ? "bg-emerald-600 text-white"
                      : "text-emerald-300 hover:text-slate-900 dark:hover:text-white"
                  }`}
                >
                  新建条目
                </button>
              ) : null}
            </div>
          </div>

          <div className="mt-6">
            {entryManageMessage && showCreateEntry ? (
              <p className="text-xs text-amber-200/90 mb-3 whitespace-pre-wrap">{entryManageMessage}</p>
            ) : null}
            {renderCreateEntryPanel()}
            {workspaceMode === "tree" && renderTreeWorkspace()}
            {workspaceMode === "collections" && renderCollectionWorkspace()}
            {workspaceMode === "harvest" && renderHarvestWorkspace()}
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
    <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/50 p-4">
      <p className="text-xs uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className="mt-3 text-2xl font-semibold text-slate-900 dark:text-white">{value}</p>
      <p className="mt-1 text-xs text-slate-500">{hint}</p>
    </div>
  );
}

