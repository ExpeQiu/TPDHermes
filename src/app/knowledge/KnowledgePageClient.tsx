"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
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
  kbFolderPathLabel,
  kbFolderSegmentLabel,
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
  /** 逻辑 doc_id（browse-tree 返回；与 id 可能为 chunk 主键不同） */
  doc_id?: string;
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

/** 浅色背景下可读的标签/按钮（dark: 保持原语义色） */
const KB_BADGE_OK =
  "bg-emerald-100 text-emerald-900 border border-emerald-300/80 dark:bg-emerald-500/20 dark:text-emerald-200 dark:border-emerald-500/30";
const KB_BADGE_WARN =
  "bg-amber-100 text-amber-950 border border-amber-300/80 dark:bg-amber-500/20 dark:text-amber-100 dark:border-amber-500/30";
const KB_BADGE_DRAFT =
  "bg-amber-100 text-amber-950 border border-amber-400/70 dark:bg-amber-500/30 dark:text-amber-50 dark:border-amber-500/40";
const KB_BTN_AMBER =
  "border-amber-400/70 bg-amber-50 text-amber-950 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100 dark:hover:bg-amber-500/20";
const KB_BTN_EMERALD =
  "border-emerald-400/70 bg-emerald-50 text-emerald-950 hover:bg-emerald-100 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-100 dark:hover:bg-emerald-500/20";
const KB_TEXT_EMERALD = "text-emerald-800 dark:text-emerald-200";
const KB_TEXT_AMBER = "text-amber-900 dark:text-amber-100";

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
  const rawId = String(row.id ?? "").trim();
  const doc_id = chromaDocIdFromParts(rawId, meta) ?? undefined;
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
    id: rawId,
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

/** kb_cache 主键形态（测试/仅缓存），不得当作 Chroma doc_id */
const KB_CACHE_PRIMARY_ID_RE = /^(qa|qb|unit)-[0-9a-f-]{8,}$/i;

function isKbCachePrimaryId(id: string | null | undefined): boolean {
  const s = id?.trim() ?? "";
  return s.length > 0 && KB_CACHE_PRIMARY_ID_RE.test(s);
}

/** Chroma 侧真实 doc_id：metadata.doc_id 或从 chunk id 解析；不含 qa-/unit- 等纯缓存主键 */
function chromaDocIdFromParts(
  rawId: string,
  meta?: Record<string, unknown> | null,
): string | null {
  const raw = rawId.trim();
  const metaDoc =
    meta && typeof meta.doc_id === "string" && meta.doc_id.trim() ? meta.doc_id.trim() : "";
  if (metaDoc) {
    if (isKbCachePrimaryId(metaDoc) || (raw && metaDoc === raw && isKbCachePrimaryId(raw))) {
      return null;
    }
    return metaDoc;
  }
  if (!raw) return null;
  const m = /^(.+)_chunk_\d+$/i.exec(raw);
  if (m?.[1]) {
    const base = m[1].trim();
    return isKbCachePrimaryId(base) ? null : base;
  }
  return null;
}

function resolveChromaDocId(entry: Pick<KBEntry, "id" | "doc_id">): string | null {
  const raw = entry.id?.trim() ?? "";
  let doc = entry.doc_id?.trim() ?? "";
  if (doc && (isKbCachePrimaryId(doc) || (raw && doc === raw && isKbCachePrimaryId(raw)))) {
    doc = "";
  }
  if (doc) return doc;
  const m = /^(.+)_chunk_\d+$/i.exec(raw);
  if (m?.[1]) {
    const base = m[1].trim();
    return isKbCachePrimaryId(base) ? null : base;
  }
  return null;
}

/** 合并/去重：Chroma doc_id，否则回落到缓存主键 id */
function resolveDocId(entry: Pick<KBEntry, "id" | "doc_id">): string | null {
  return resolveChromaDocId(entry) ?? (entry.id?.trim() || null);
}

/** 仅 kb_cache 行（无 Chroma doc），如测试数据 qa-* / unit-* */
function isCacheOnlyKbEntry(entry: Pick<KBEntry, "id" | "doc_id">): boolean {
  const id = entry.id?.trim();
  if (!id) return false;
  if (isKbCachePrimaryId(id)) return true;
  return !resolveChromaDocId(entry);
}

/** 目录树 / 缓存引用 → 逻辑 doc_id */
function kbRefDocId(ref: string, explicitDocId?: string | null): string {
  const hint = explicitDocId?.trim();
  if (hint && !isKbCachePrimaryId(hint)) return hint;
  return resolveChromaDocId({ id: ref, doc_id: hint }) ?? ref.trim();
}

async function fetchKbCacheRow(
  refId: string,
  docIdHint?: string | null,
): Promise<Record<string, unknown> | null> {
  const candidates = [
    ...new Set(
      [refId.trim(), kbRefDocId(refId, docIdHint)].filter((x) => x.length > 0),
    ),
  ];
  for (const id of candidates) {
    try {
      return await apiGet<Record<string, unknown>>(
        `/kb/cache/entry/${encodeURIComponent(id)}`,
      );
    } catch {
      /* try next ref */
    }
  }
  return null;
}

function entryBodyText(entry: Pick<KBEntry, "body" | "summary">): string {
  return (entry.body ?? entry.summary ?? "").trim();
}

function mergeBodiesForDoc(entry: KBEntry, all: KBEntry[]): string {
  const docId = resolveDocId(entry);
  const candidates = docId ? all.filter((e) => resolveDocId(e) === docId) : [entry];
  let best = "";
  for (const c of candidates) {
    const b = entryBodyText(c);
    if (b.length > best.length) best = b;
  }
  return best || entryBodyText(entry);
}

/** 对话收割待审核：未发布或 published 未写入缓存（undefined） */
function isHarvestDraftEntry(e: KBEntry): boolean {
  return e.published !== true;
}

function dedupeKbEntriesByDocId(entries: KBEntry[]): KBEntry[] {
  const seen = new Map<string, KBEntry>();
  for (const e of entries) {
    const did = resolveDocId(e) ?? e.id;
    const prev = seen.get(did);
    if (!prev || entryBodyText(e).length > entryBodyText(prev).length) {
      seen.set(did, e);
    }
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

function harvestDefaultFolderPath(entry: KBEntry): string {
  const raw = entry.folder_path?.trim() ?? "";
  if (!raw || raw === "conversation_harvest" || raw === entry.source_type) {
    return "02-知识库/对话收割";
  }
  return raw;
}

function entryEditFormFrom(entry: KBEntry, body: string) {
  const isHarvest = entry.source_type === "conversation_harvest";
  return {
    title: entry.title,
    domain: entry.domain && entry.domain !== "_uncategorized" ? entry.domain : "structured_tech",
    folder_path: isHarvest ? harvestDefaultFolderPath(entry) : entry.folder_path || "02-知识库/导入",
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
  if (node.segment) return kbFolderSegmentLabel(node.segment);
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

function entryMetadataDirty(
  entry: Pick<KBEntry, "domain" | "folder_path">,
  draft: { domain: string; folder_path: string },
): boolean {
  const baseDomain =
    entry.domain && entry.domain !== "_uncategorized" ? entry.domain : "structured_tech";
  const basePath = entry.folder_path?.trim() ?? "";
  return (
    draft.domain.trim() !== baseDomain || draft.folder_path.trim() !== basePath
  );
}

function KbEntryMetadataFields({
  domain,
  folderPath,
  disabled,
  busy,
  dirty,
  onDomainChange,
  onFolderPathChange,
  onSave,
}: {
  domain: string;
  folderPath: string;
  disabled?: boolean;
  busy?: boolean;
  dirty?: boolean;
  onDomainChange: (value: string) => void;
  onFolderPathChange: (value: string) => void;
  onSave: () => void;
}) {
  const classify = entryClassifyStatus({ domain, folder_path: folderPath });
  return (
    <div className="space-y-2">
      <label className="block text-sm">
        <span className="text-slate-500 text-xs">业务域</span>
        <select
          value={domain}
          disabled={disabled}
          onChange={(e) => onDomainChange(e.target.value)}
          className="mt-1 w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm disabled:opacity-50"
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
        <span className="text-slate-500 text-xs">目录路径</span>
        <input
          value={folderPath}
          disabled={disabled}
          onChange={(e) => onFolderPathChange(e.target.value)}
          placeholder="02-知识库/子目录"
          className="mt-1 w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm disabled:opacity-50"
        />
      </label>
      <p
        className={`text-xs ${
          classify.ok
            ? "text-emerald-700 dark:text-emerald-300/90"
            : "text-amber-700 dark:text-amber-300/90"
        }`}
        title={classify.hint}
      >
        {classify.label}
        {!classify.ok ? ` · ${classify.hint}` : null}
      </p>
      <button
        type="button"
        disabled={disabled || busy || !dirty}
        onClick={onSave}
        className="w-full rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-40"
      >
        {busy ? "保存中…" : "保存分类"}
      </button>
    </div>
  );
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
          <code className="text-emerald-700 dark:text-emerald-300/90">domain</code>（业务域）+{" "}
          <code className="text-emerald-700 dark:text-emerald-300/90">folder_path</code>（Obsidian 目录，用 / 分隔）生成树
        </li>
        <li>
          <strong className="text-slate-700 dark:text-slate-300">按集合</strong>：按 Chroma{" "}
          <code className="text-emerald-700 dark:text-emerald-300/90">collection</code> 分组，规范名如{" "}
          <code className="text-emerald-700 dark:text-emerald-300/90">public.structured_tech.geely_tech</code>
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

/** 筛选工具栏下方：条目列表（左 1/3）与详情（右 2/3） */
function KbEntryListDetailSplit({
  list,
  detail,
}: {
  list: ReactNode;
  detail: ReactNode | null;
}) {
  if (!detail) {
    return <>{list}</>;
  }
  return (
    <div className="grid w-full gap-4 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-start">
      <div className="min-w-0 max-h-[min(75vh,calc(100vh-14rem))] overflow-y-auto">
        {list}
      </div>
      <div className="min-w-0 lg:sticky lg:top-4 max-h-[min(85vh,calc(100vh-8rem))] overflow-y-auto">
        {detail}
      </div>
    </div>
  );
}

// ============== 页面 ==============
export default function KnowledgePageClient() {
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
  const [detailBody, setDetailBody] = useState<string | null>(null);
  const [detailBodyLoading, setDetailBodyLoading] = useState(false);
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
  const [showAddCategoryPanel, setShowAddCategoryPanel] = useState(false);
  const [addCategoryDomain, setAddCategoryDomain] = useState("structured_tech");
  const [addCategoryParentPath, setAddCategoryParentPath] = useState("02-知识库");
  const [addCategorySegment, setAddCategorySegment] = useState("");
  const [addCategoryMessage, setAddCategoryMessage] = useState<string | null>(null);
  const [addCategoryBusy, setAddCategoryBusy] = useState(false);
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
  const [previewMode, setPreviewMode] = useState<"summary" | "markdown">("summary");

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

  const browseEntriesRef = useRef(browseEntries);
  browseEntriesRef.current = browseEntries;

  const detailFetchAbortRef = useRef<AbortController | null>(null);

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

  const pickDefaultCollection = useCallback(
    (domain: string) => {
      const dom = domain.trim();
      const fromTree = treeNodeStats.collectionCounts[0]?.name;
      if (fromTree) return fromTree;
      const byDomain = collections.find((c) => c.name.includes(dom))?.name;
      if (byDomain) return byDomain;
      const publicCol = collections.find((c) => isPublicKbCollection(c.name))?.name;
      if (publicCol) return publicCol;
      return collections[0]?.name ?? "";
    },
    [collections, treeNodeStats.collectionCounts],
  );

  const addCategoryFullPath = useMemo(() => {
    const parent = addCategoryParentPath.trim().replace(/\/+$/, "");
    const seg = addCategorySegment.trim().replace(/^\/+|\/+$/g, "");
    if (!seg) return parent;
    return parent ? `${parent}/${seg}` : seg;
  }, [addCategoryParentPath, addCategorySegment]);

  const applyCategoryTarget = useCallback((path: string, domain: string) => {
    const dom = domain.trim() || "structured_tech";
    const fp = path.trim() || "02-知识库/手动录入";
    setTreeTargetDomain(dom);
    setTreeTargetFolderPath(fp);
    setIngestDomain(dom);
    setIngestFolderPath(fp);
    return { domain: dom, folder_path: fp };
  }, []);

  const toggleAddCategoryPanel = () => {
    setShowAddCategoryPanel((open) => {
      const next = !open;
      if (next) {
        setAddCategoryDomain(
          selectedTreeNode?.domain?.trim() || treeTargetDomain.trim() || "structured_tech",
        );
        setAddCategoryParentPath(
          selectedTreeFolderPath.trim() || treeTargetFolderPath.trim() || "02-知识库",
        );
        setAddCategorySegment("");
        setAddCategoryMessage(null);
      }
      return next;
    });
  };

  const jumpToCreateFromTree = (opts?: { domain?: string; folder_path?: string }) => {
    const domain = opts?.domain?.trim() || treeTargetDomain.trim() || "structured_tech";
    const folder_path = opts?.folder_path?.trim() || treeTargetFolderPath.trim() || "02-知识库/手动录入";
    const col = pickDefaultCollection(domain);
    setCreateEntryForm((f) => ({
      ...f,
      collection: col,
      domain,
      folder_path,
    }));
    setShowCreateEntry(true);
    setPage(0);
  };

  const jumpToIngestFromTreeWithTarget = (opts?: { domain?: string; folder_path?: string }) => {
    const { domain, folder_path } = applyCategoryTarget(
      opts?.folder_path ?? treeTargetFolderPath,
      opts?.domain ?? treeTargetDomain,
    );
    setIngestDomain(domain);
    setIngestFolderPath(folder_path);
    handleWorkspaceMode("ingest");
  };

  const createCategoryIndexEntry = async () => {
    if (USE_MOCK_KB || addCategoryBusy) return;
    const path = addCategoryFullPath.trim();
    const seg = addCategorySegment.trim();
    if (!seg) {
      setAddCategoryMessage("请填写新分类名称。");
      return;
    }
    if (!path) {
      setAddCategoryMessage("目录路径无效，请检查父路径与新分类名称。");
      return;
    }
    const col = pickDefaultCollection(addCategoryDomain);
    if (!col) {
      setAddCategoryMessage("暂无可用知识集合，请先创建或同步集合。");
      return;
    }
    setAddCategoryBusy(true);
    setAddCategoryMessage(null);
    try {
      const domain = addCategoryDomain.trim() || "structured_tech";
      await apiPost<{ entry_id?: string; doc_id?: string }>("/kb/entries/manual", {
        collection: col,
        project_id: ingestProjectId || "__all__",
        title: `${seg}（分类索引）`,
        content: `# ${seg}\n\n> 本条目用于在目录树中占位展示「${path}」分类，可在详情页编辑或替换为正式文档。`,
        domain,
        folder_path: path,
        published: true,
        sync_cache: true,
      });
      applyCategoryTarget(path, domain);
      setAddCategoryMessage(`已创建分类索引：${path}`);
      await reloadKbBrowse();
      await reloadBrowseTree();
    } catch (e) {
      setAddCategoryMessage(e instanceof Error ? e.message : "创建分类索引失败");
    } finally {
      setAddCategoryBusy(false);
    }
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
    const docId = resolveChromaDocId(fromEntry);
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

  const saveEntryMetadata = async () => {
    if (!selectedEntry || USE_MOCK_KB || entryManageBusy) return;
    const fromEntry = entryById.get(selectedEntry.id) ?? selectedEntry;
    const docId = resolveChromaDocId(fromEntry);
    if (!docId) {
      setEntryManageMessage("无法解析 doc_id，暂不支持保存分类。");
      return;
    }
    const projectId =
      fromEntry.projects[0] != null ? String(fromEntry.projects[0]) : "__all__";
    const body = fullContent(fromEntry) || entryEditForm.content;
    setEntryManageBusy(true);
    setEntryManageMessage(null);
    try {
      await apiPatch("/kb/entries/" + encodeURIComponent(docId), {
        collection: fromEntry.collection,
        project_id: projectId,
        sync_cache: true,
        title: fromEntry.title,
        content: body,
        metadata: {
          domain: entryEditForm.domain.trim(),
          folder_path: entryEditForm.folder_path.trim(),
          published: fromEntry.published !== false,
        },
      });
      setEntryManageMessage("已保存业务域与目录路径。");
      await reloadKbBrowse();
      await reloadBrowseTree();
    } catch (e) {
      setEntryManageMessage(e instanceof Error ? e.message : "保存分类失败");
    } finally {
      setEntryManageBusy(false);
    }
  };

  const deleteKbDocument = async (
    entry: Pick<KBEntry, "id" | "doc_id" | "collection" | "projects" | "title">,
    confirmTitle?: string,
  ) => {
    if (USE_MOCK_KB || entryManageBusy) return false;
    const cacheId = entry.id?.trim();
    const chromaDocId = resolveChromaDocId(entry) ?? (cacheId ? kbRefDocId(cacheId, entry.doc_id) : null);
    const cacheOnly = isCacheOnlyKbEntry(entry);
    if (!cacheOnly && !chromaDocId) {
      const msg = "无法解析 doc_id，暂不支持删除。";
      setEntryManageMessage(msg);
      setNodeManageMessage(msg);
      return false;
    }
    if (cacheOnly && !cacheId) {
      const msg = "无法解析缓存条目 id。";
      setEntryManageMessage(msg);
      setNodeManageMessage(msg);
      return false;
    }
    const label = confirmTitle || entry.title || chromaDocId || cacheId || "条目";
    if (
      !window.confirm(
        cacheOnly
          ? `确定删除缓存知识点「${label}」？\n（仅本地 kb_cache，无 Chroma 文档）`
          : `确定删除知识点「${label}」？\n将移除 Chroma 中该 doc 的全部 chunk，不可恢复。`,
      )
    ) {
      return false;
    }
    const projectId =
      entry.projects[0] != null ? String(entry.projects[0]) : "__all__";
    setEntryManageBusy(true);
    setEntryManageMessage(null);
    setNodeManageMessage(null);
    const colQ = encodeURIComponent(entry.collection);
    const projQ = encodeURIComponent(projectId);
    const cacheEntryUrl = (id: string) =>
      `/kb/cache/entry/${encodeURIComponent(id)}?collection=${colQ}`;
    const cacheByDocUrl = (docId: string) =>
      `/kb/cache/by-doc/${encodeURIComponent(docId)}?collection=${colQ}`;

    try {
      const useCacheDelete =
        (cacheOnly && !!cacheId) || (!!cacheId && isKbCachePrimaryId(cacheId));
      if (useCacheDelete && cacheId) {
        await apiDelete(cacheEntryUrl(cacheId));
      } else if (chromaDocId) {
        let removed = false;
        try {
          await apiDelete(
            `/kb/entries/${encodeURIComponent(chromaDocId)}?collection=${colQ}&project_id=${projQ}`,
          );
          removed = true;
        } catch {
          /* Chroma 可能已不存在，继续清缓存 */
        }
        if (!removed) {
          try {
            await apiDelete(cacheByDocUrl(chromaDocId));
            removed = true;
          } catch {
            if (cacheId) {
              await apiDelete(cacheEntryUrl(cacheId));
              removed = true;
            }
          }
        }
        if (!removed) {
          throw new Error("entry_not_found");
        }
      } else if (cacheId) {
        await apiDelete(cacheEntryUrl(cacheId));
      }
      if (
        selectedEntry &&
        (selectedEntry.id === entry.id ||
          (chromaDocId && resolveChromaDocId(selectedEntry) === chromaDocId))
      ) {
        setSelectedEntry(null);
        setEntryEditing(false);
      }
      await reloadKbBrowse();
      await reloadBrowseTree();
      const okMsg = `已删除：${label}`;
      setEntryManageMessage(okMsg);
      setNodeManageMessage(okMsg);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "删除失败";
      let hint = msg;
      if (msg.includes("entry_not_found") || msg.includes("cache_entry_not_found")) {
        hint = cacheOnly
          ? `未找到缓存条目 id=${cacheId}，请刷新列表后重试`
          : `未在 Chroma/缓存中找到 doc_id=${chromaDocId ?? cacheId}，请刷新后重试`;
      } else if (msg.includes("404")) {
        hint = "删除接口不可用，请重启后端（./stop.sh && ./start.sh）";
      }
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
        doc_id: d.doc_id,
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
    const fromEntry = entryById.get(entry.id) ?? entry;
    const docId = resolveChromaDocId(fromEntry);
    if (!docId || USE_MOCK_KB || publishBusy) {
      if (!docId && !USE_MOCK_KB) {
        setPublishMessage("无法解析 doc_id，无法更新发布状态。");
      }
      return;
    }
    const projectId =
      fromEntry.projects[0] != null ? String(fromEntry.projects[0]) : "__all__";
    setPublishBusy(true);
    setPublishMessage(null);
    try {
      const sameSelection = selectedEntry?.id === fromEntry.id;
      const draft = sameSelection
        ? entryEditForm
        : entryEditFormFrom(fromEntry, fullContent(fromEntry));
      const metadataDirty = entryMetadataDirty(fromEntry, draft);
      if (metadataDirty) {
        const body = fullContent(fromEntry) || draft.content;
        await apiPatch("/kb/entries/" + encodeURIComponent(docId), {
          collection: fromEntry.collection,
          project_id: projectId,
          sync_cache: true,
          title: fromEntry.title,
          content: body,
          metadata: {
            domain: draft.domain.trim(),
            folder_path: draft.folder_path.trim(),
            published: fromEntry.published !== false,
          },
        });
      }
      await apiPost("/kb/publish", {
        collection: fromEntry.collection,
        doc_ids: [docId],
        published,
        project_id: projectId,
        sync_cache: true,
      });
      setPublishMessage(
        published
          ? metadataDirty
            ? "已保存分类并发布，缓存已同步。"
            : "已发布并完成缓存同步。"
          : "已保持草稿（未对外发布）。",
      );
      await reloadKbBrowse();
      await reloadBrowseTree();
      setSelectedEntry((prev) =>
        prev && prev.id === fromEntry.id ? { ...prev, published } : prev,
      );
    } catch (e) {
      setPublishMessage(e instanceof Error ? e.message : "发布状态更新失败。");
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
    const draft = harvestAllEntries.filter(isHarvestDraftEntry);
    const published = harvestAllEntries.filter((e) => e.published === true);
    return {
      total: harvestAllEntries.length,
      draft: draft.length,
      published: published.length,
    };
  }, [harvestAllEntries]);

  const harvestVisibleEntries = useMemo(() => {
    if (harvestPublishFilter === "draft") {
      return harvestAllEntries.filter(isHarvestDraftEntry);
    }
    if (harvestPublishFilter === "published") {
      return harvestAllEntries.filter((e) => e.published === true);
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
    if (selectedEntry?.id === entry.id && detailBody) return detailBody;
    return mergeBodiesForDoc(entry, browseEntries);
  };

  const selectedEntryId = selectedEntry?.id ?? null;

  // 选中条目变化：拉取正文（勿依赖 browseEntries，避免 setBrowseEntries 触发循环刷新）
  useEffect(() => {
    detailFetchAbortRef.current?.abort();
    detailFetchAbortRef.current = null;

    if (!selectedEntryId) {
      setDetailBody(null);
      setDetailBodyLoading(false);
      setEntryEditing(false);
      return;
    }

    const fromEntry = browseEntriesRef.current.find((e) => e.id === selectedEntryId);
    if (!fromEntry) return;

    const merged = mergeBodiesForDoc(fromEntry, browseEntriesRef.current);
    setEntryEditForm(entryEditFormFrom(fromEntry, merged));
    setDetailBody(merged || null);

    if (USE_MOCK_KB) {
      setDetailBodyLoading(false);
      return;
    }

    if (merged.length >= 32) {
      setDetailBodyLoading(false);
      return;
    }

    const ac = new AbortController();
    detailFetchAbortRef.current = ac;
    setDetailBodyLoading(true);

    void (async () => {
      try {
        const row = await fetchKbCacheRow(fromEntry.id, fromEntry.doc_id);
        if (ac.signal.aborted || !row) return;
        const mapped = mapCacheRow(row);
        setBrowseEntries((prev) => {
          const idx = prev.findIndex((e) => e.id === mapped.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = mapped;
            return next;
          }
          return [...prev, mapped];
        });
        const body = mergeBodiesForDoc(mapped, [
          ...browseEntriesRef.current.filter((e) => e.id !== mapped.id),
          mapped,
        ]);
        if (!ac.signal.aborted) {
          setDetailBody(body || merged || null);
        }
      } catch {
        if (!ac.signal.aborted) setDetailBody(merged || null);
      } finally {
        if (!ac.signal.aborted) setDetailBodyLoading(false);
      }
    })();

    return () => {
      ac.abort();
    };
  }, [selectedEntryId]);

  // 列表刷新后：若当前选中条目正文变长，静默更新（不进入 loading）
  useEffect(() => {
    if (!selectedEntryId) return;
    const fromEntry = entryById.get(selectedEntryId);
    if (!fromEntry) return;
    const merged = mergeBodiesForDoc(fromEntry, browseEntries);
    setEntryEditForm(entryEditFormFrom(fromEntry, merged));
    if (merged.length > 0) {
      setDetailBody((prev) => {
        if (!prev || merged.length >= prev.length) return merged;
        return prev;
      });
      if (merged.length >= 32) setDetailBodyLoading(false);
    }
  }, [browseEntries, selectedEntryId, entryById]);

  const openTreeDocument = async (d: BrowseDoc) => {
    const docRef = kbRefDocId(d.id, d.doc_id);
    const existing =
      entryById.get(d.id) ??
      browseEntriesRef.current.find(
        (e) =>
          e.id === d.id ||
          resolveDocId(e) === docRef ||
          resolveChromaDocId(e) === docRef,
      );
    if (existing) {
      handleEntryClick({
        ...existing,
        title: d.title || existing.title,
        doc_id: existing.doc_id ?? d.doc_id,
      });
      return;
    }
    if (USE_MOCK_KB) return;
    const row = await fetchKbCacheRow(d.id, d.doc_id);
    if (!row) return;
    const mapped = mapCacheRow(row);
    setBrowseEntries((prev) =>
      prev.some((e) => e.id === mapped.id || resolveDocId(e) === resolveDocId(mapped))
        ? prev
        : [...prev, mapped],
    );
    handleEntryClick({ ...mapped, title: d.title || mapped.title });
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
              {kbFolderPathLabel(d.folder_path) || "—"} · {kbCollectionLabel(d.collection, { projectNames: projectNameMap })}
            </div>
          </button>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded ${
                classify.ok ? KB_BADGE_OK : KB_BADGE_WARN
              }`}
              title={classify.hint}
            >
              {classify.label}
            </span>
            {d.published === false ? (
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${KB_BADGE_DRAFT}`}>
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
              onClick={(ev) => {
                ev.stopPropagation();
                void deleteTreeDocument(d);
              }}
              className="rounded px-2 py-0.5 text-[11px] border border-rose-400/60 text-rose-700 hover:bg-rose-50 dark:border-rose-500/50 dark:text-rose-400 dark:hover:bg-rose-500/10 disabled:opacity-40"
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

    const treeDocListPanel = (
      <div className="flex flex-col rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-200/40 dark:bg-slate-800/40 p-3 max-h-[70vh] min-h-[320px]">
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
        <div className="flex-1 overflow-auto space-y-2 min-h-0">
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
    );

    return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <KbClassifyRulesHint compact />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={toggleAddCategoryPanel}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
              showAddCategoryPanel
                ? "border-emerald-500/60 bg-emerald-50 text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-200"
                : "border-emerald-400/70 text-emerald-800 hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-500/10"
            }`}
          >
            新增分类及功能
          </button>
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
              className={`rounded-lg px-3 py-1.5 text-xs font-medium ${KB_BTN_AMBER}`}
            >
              {unclassifiedCount} 条未完整分类
            </button>
          ) : null}
        </div>
      </div>
      {showAddCategoryPanel ? (
        <div className="rounded-xl border border-emerald-400/50 bg-emerald-50/80 dark:border-emerald-500/30 dark:bg-emerald-950/20 p-4 space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-medium text-emerald-900 dark:text-emerald-100">新增分类及功能</p>
              <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
                目录树由条目的 domain + folder_path 聚合；创建分类索引可在左侧树中占位展示。
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowAddCategoryPanel(false)}
              className="text-slate-400 hover:text-slate-700 dark:hover:text-white text-lg leading-none shrink-0"
              aria-label="关闭"
            >
              ×
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block text-xs">
              <span className="text-slate-500">业务域</span>
              <select
                value={addCategoryDomain}
                onChange={(e) => setAddCategoryDomain(e.target.value)}
                className="mt-1 w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-sm"
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
            <label className="block text-xs sm:col-span-2">
              <span className="text-slate-500">父级路径</span>
              <input
                value={addCategoryParentPath}
                onChange={(e) => setAddCategoryParentPath(e.target.value)}
                placeholder="如 02-知识库/智能驾驶"
                className="mt-1 w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-sm font-mono"
              />
            </label>
            <label className="block text-xs">
              <span className="text-slate-500">新分类名称</span>
              <input
                value={addCategorySegment}
                onChange={(e) => setAddCategorySegment(e.target.value)}
                placeholder="如 NOA/城市NOA"
                className="mt-1 w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1.5 text-sm"
              />
            </label>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400 font-mono">
            完整路径：
            <span className="text-emerald-800 dark:text-emerald-200 ml-1">
              {addCategoryFullPath || "—"}
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            {!USE_MOCK_KB ? (
              <button
                type="button"
                disabled={addCategoryBusy || !addCategorySegment.trim()}
                onClick={() => void createCategoryIndexEntry()}
                className="rounded-lg bg-emerald-600/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
              >
                {addCategoryBusy ? "创建中…" : "创建分类索引"}
              </button>
            ) : null}
            {!USE_MOCK_KB ? (
              <button
                type="button"
                disabled={!addCategorySegment.trim()}
                onClick={() => {
                  const path = addCategoryFullPath.trim();
                  applyCategoryTarget(path, addCategoryDomain);
                  jumpToCreateFromTree({
                    domain: addCategoryDomain.trim(),
                    folder_path: path,
                  });
                  setShowAddCategoryPanel(false);
                }}
                className="rounded-lg bg-blue-600/90 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-40"
              >
                新建条目
              </button>
            ) : null}
            <button
              type="button"
              disabled={!addCategorySegment.trim()}
              onClick={() => {
                jumpToIngestFromTreeWithTarget({
                  domain: addCategoryDomain,
                  folder_path: addCategoryFullPath,
                });
                setShowAddCategoryPanel(false);
              }}
              className="rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-1.5 text-xs text-slate-800 dark:text-slate-200 hover:bg-slate-200 dark:bg-slate-800 disabled:opacity-40"
            >
              导入到此分类
            </button>
          </div>
          {addCategoryMessage ? (
            <p className={`text-xs whitespace-pre-wrap ${KB_TEXT_EMERALD}`}>{addCategoryMessage}</p>
          ) : null}
        </div>
      ) : null}
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
      {selectedEntry ? (
        <div className="lg:col-span-9 grid gap-4 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-start min-w-0">
          <div className="min-w-0">{treeDocListPanel}</div>
          <div className="min-w-0 max-h-[min(85vh,calc(100vh-8rem))] overflow-y-auto lg:sticky lg:top-4">
            {renderDetailPanel(selectedEntry)}
          </div>
        </div>
      ) : (
        <>
      <div className="lg:col-span-5">{treeDocListPanel}</div>
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
                  {kbFolderPathLabel(selectedTreeFolderPath) ||
                    "（域根 · 条目可能无 folder_path）"}
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
                <span className={`text-right font-medium ${KB_TEXT_AMBER}`}>
                  {treeNodeStats.draftCount}
                </span>
                <span className="text-slate-500">未完整分类</span>
                <span className={`text-right font-medium ${KB_TEXT_AMBER}`}>
                  {treeNodeStats.unclassifiedCount}
                </span>
                {treeNodeStats.harvestCount > 0 ? (
                  <>
                    <span className="text-slate-500">对话收割</span>
                    <span className={`text-right font-medium ${KB_TEXT_EMERALD}`}>
                      {treeNodeStats.harvestCount}
                    </span>
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
                  onClick={() => jumpToCreateFromTree()}
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
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium ${KB_BTN_AMBER}`}
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
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium ${KB_BTN_AMBER}`}
                >
                  未分类 ({treeNodeStats.unclassifiedCount})
                </button>
              ) : null}
              {treeNodeStats.harvestCount > 0 ? (
                <button
                  type="button"
                  onClick={() => handleWorkspaceMode("harvest")}
                  className={`rounded-lg px-3 py-1.5 text-xs font-medium ${KB_BTN_EMERALD}`}
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
      </div>
        </>
      )}
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
                  classify.ok ? KB_BADGE_OK : KB_BADGE_WARN
                }`}
                title={classify.hint}
              >
                {classify.label}
              </span>
            ) : null}
            {entry.source_type === "conversation_harvest" && isHarvestDraftEntry(entry) ? (
              <span className={`text-xs px-2 py-1 rounded font-medium ${KB_BADGE_DRAFT}`}>
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
        <p className="text-slate-400 text-sm mb-3 line-clamp-3 whitespace-pre-wrap">
          {entryBodyText(entry) || entry.summary || "（无正文预览）"}
        </p>
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
                    {kbFolderPathLabel(entry.folder_path)}
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
        <div className="mt-3 flex flex-wrap gap-2" onClick={(e) => e.stopPropagation()}>
          {workspaceMode !== "harvest" && !classify.ok ? (
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
          ) : null}
          {!USE_MOCK_KB ? (
            <button
              type="button"
              disabled={entryManageBusy || !entry.id?.trim()}
              title={
                isCacheOnlyKbEntry(entry)
                  ? "删除本地缓存条目"
                  : resolveChromaDocId(entry)
                    ? "删除该知识点"
                    : "无法删除"
              }
              onClick={() => void deleteKbDocument(entry, entry.title)}
              className="rounded px-2 py-1 text-[11px] border border-rose-400/60 text-rose-700 hover:bg-rose-50 dark:border-rose-500/50 dark:text-rose-400 dark:hover:bg-rose-500/10 disabled:opacity-40"
            >
              删除
            </button>
          ) : null}
        </div>
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
          <p className={`font-medium ${KB_TEXT_EMERALD}`}>对话收割审核队列</p>
          <p className="text-xs text-slate-400 mt-1">
            来自对话「存入知识库」的摘录，默认草稿。左侧点选条目，右侧展开审核与配置面板。
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
          <p className={`text-xs mb-3 whitespace-pre-wrap ${KB_TEXT_AMBER}`}>{entryManageMessage}</p>
        ) : null}
        <KbEntryListDetailSplit
          list={
            <>
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
            </>
          }
          detail={selectedEntry ? renderDetailPanel(selectedEntry) : null}
        />
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
                  : `bg-slate-200 dark:bg-slate-800 border-amber-300/80 ${KB_TEXT_AMBER} hover:bg-amber-100 dark:hover:bg-amber-900/30`
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
                    className="rounded-lg border border-rose-400/60 px-3 py-1.5 text-xs text-rose-700 hover:bg-rose-50 dark:border-rose-500/50 dark:text-rose-400 dark:hover:bg-rose-500/10 disabled:opacity-40"
                  >
                    删除此合集全部
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
        {entryManageMessage && workspaceMode === "collections" ? (
          <p className={`text-xs mb-3 whitespace-pre-wrap ${KB_TEXT_AMBER}`}>{entryManageMessage}</p>
        ) : null}
        <KbEntryListDetailSplit
          list={
            <>
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
            </>
          }
          detail={selectedEntry ? renderDetailPanel(selectedEntry) : null}
        />
      </div>
    );
  };

  const renderSearchView = () => (
    <div>
      <p className="text-xs text-slate-500 mb-2">
        默认跨全部知识集合检索（/kb/query-all）；可选限定其一。
      </p>
      <div className="flex flex-wrap gap-3 mb-4">
        <select
          value={searchScopeCollection}
          onChange={(e) => setSearchScopeCollection(e.target.value)}
          className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-white min-w-[200px]"
        >
          <option value="">全部知识集合</option>
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
        <KbEntryListDetailSplit
          list={
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
                  <p className="text-xs text-emerald-400/90" title={entry.folder_path}>
                    路径：{kbFolderPathLabel(entry.folder_path)}
                  </p>
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
                      className="rounded px-2 py-1 text-[11px] border border-rose-400/60 text-rose-700 hover:bg-rose-50 dark:border-rose-500/50 dark:text-rose-400 dark:hover:bg-rose-500/10 disabled:opacity-40"
                    >
                      删除知识点
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
            </div>
          }
          detail={selectedEntry ? renderDetailPanel(selectedEntry) : null}
        />
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
          <p className={`text-sm whitespace-pre-wrap ${KB_TEXT_AMBER}`}>{ingestMessage}</p>
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
          <p className={`text-sm font-medium ${KB_TEXT_EMERALD}`}>新建知识条目</p>
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
    const mdBody = fullContent(fromEntry);
    const isHarvestReview =
      fromEntry.source_type === "conversation_harvest" ||
      workspaceMode === "harvest";
    const displayBody = mdBody.trim();
    const bodyCharCount = displayBody.length;

    const chromaDocId = resolveChromaDocId(fromEntry);
    const cacheOnlyEntry = isCacheOnlyKbEntry(fromEntry);
    const cacheEntryId = fromEntry.id?.trim() || null;
    const displayDocId = chromaDocId ?? cacheEntryId;
    const canDeleteEntry = !!cacheEntryId;

    const renderHarvestAuditActions = () =>
      fromEntry.source_type === "conversation_harvest" && chromaDocId ? (
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
            {publishBusy ? "处理中…" : "通过后发布"}
          </button>
          <button
            type="button"
            disabled={USE_MOCK_KB || publishBusy || fromEntry.published === false}
            className={`rounded-lg border px-3 py-1.5 text-sm disabled:opacity-40 ${
              fromEntry.published === false
                ? "border-slate-300 dark:border-slate-700 text-slate-500 cursor-not-allowed"
                : "border-slate-300 dark:border-slate-600 text-slate-800 dark:text-slate-200 hover:bg-slate-200 dark:bg-slate-800"
            }`}
            title={fromEntry.published === false ? "当前已是草稿" : "恢复为草稿态"}
            onClick={(ev) => {
              ev.stopPropagation();
              if (fromEntry.published === false) return;
              void publishHarvestEntry(fromEntry, false);
            }}
          >
            降为草稿
          </button>
        </div>
      ) : null;

    return (
      <div className="bg-slate-200/60 dark:bg-slate-800/60 border border-blue-500 rounded-xl p-4 sm:p-5">
        <div className="flex items-start justify-between mb-4 gap-2 flex-wrap">
          <div className="flex flex-col gap-1">
            <h3 className="text-xl font-bold text-slate-900 dark:text-white">{entry.title}</h3>
            <div className="flex gap-2 flex-wrap">
              {entry.source_type === "conversation_harvest" &&
              entry.published === false ? (
                <span className={`text-xs px-2 py-0.5 rounded font-medium ${KB_BADGE_DRAFT}`}>
                  待审核 · 草稿
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!USE_MOCK_KB ? (
              <>
                {chromaDocId && !cacheOnlyEntry ? (
                  entryEditing ? (
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
                  )
                ) : cacheOnlyEntry ? (
                  <span className="text-xs text-slate-500">仅本地缓存，无 Chroma 正文编辑</span>
                ) : (
                  <span className="text-xs text-amber-600 dark:text-amber-300/90">
                    无法解析 doc_id
                  </span>
                )}
                <button
                  type="button"
                  disabled={entryManageBusy || !canDeleteEntry}
                  title={
                    canDeleteEntry
                      ? cacheOnlyEntry
                        ? "删除本地缓存条目"
                        : "删除该知识点"
                      : "无法删除"
                  }
                  onClick={(ev) => {
                    ev.stopPropagation();
                    void deleteSelectedEntry();
                  }}
                  className="rounded-lg border border-rose-400/60 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-50 dark:border-rose-500/50 dark:text-rose-300 dark:hover:bg-rose-500/10 disabled:opacity-40"
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
          <p className={`text-xs mb-3 whitespace-pre-wrap ${KB_TEXT_AMBER}`}>{entryManageMessage}</p>
        ) : null}
        {publishMessage && !isHarvestReview ? (
          <p className="text-xs text-emerald-800 dark:text-emerald-300/90 mb-3">{publishMessage}</p>
        ) : null}
        <div className="space-y-4">
          {isHarvestReview ? (
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(280px,22rem)] gap-5 items-start">
              {/* 左栏：审核信息 */}
              <section className="rounded-xl border-2 border-amber-500/35 bg-amber-500/5 dark:bg-amber-950/20 p-4 flex flex-col min-h-[min(56vh,38rem)]">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3 shrink-0">
                  <h4 className={`text-sm font-semibold ${KB_TEXT_AMBER}`}>审核信息</h4>
                  <span className="text-xs text-slate-500">
                    {bodyCharCount > 0 ? `${bodyCharCount} 字` : "正文为空"}
                  </span>
                </div>
                {entryEditing ? (
                  <div className="flex-1 space-y-3 overflow-y-auto min-h-0">
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
                    <label className="block text-sm flex-1 flex flex-col min-h-[12rem]">
                      <span className="text-slate-400">正文（Markdown）</span>
                      <textarea
                        value={entryEditForm.content}
                        onChange={(e) =>
                          setEntryEditForm((f) => ({ ...f, content: e.target.value }))
                        }
                        className="mt-1 w-full flex-1 min-h-[12rem] rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm font-mono"
                      />
                    </label>
                  </div>
                ) : (
                  <>
                    {!displayBody && detailBodyLoading ? (
                      <p className="text-sm text-slate-400 py-8 text-center flex-1">
                        正在加载正文…
                      </p>
                    ) : displayBody ? (
                      <div className="flex-1 min-h-0 flex flex-col">
                        <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-950/80 px-4 py-3">
                          <div className="prose prose-sm max-w-none dark:prose-invert text-slate-800 dark:text-slate-200">
                            <KbMarkdown assetContext={kbAssetContextFromEntry(fromEntry)}>
                              {displayBody}
                            </KbMarkdown>
                          </div>
                        </div>
                        {detailBodyLoading ? (
                          <p className="text-xs text-slate-500 mt-2 text-center shrink-0">
                            正在同步完整正文…
                          </p>
                        ) : null}
                      </div>
                    ) : (
                      <div className="flex-1 rounded-lg border border-dashed border-amber-500/40 bg-slate-100/80 dark:bg-slate-900/50 px-4 py-8 text-center text-sm text-slate-500">
                        未加载到正文。请点「编辑」核对，或刷新列表后重试。
                      </div>
                    )}
                    {fromEntry.summary && fromEntry.summary !== displayBody.slice(0, 280) ? (
                      <p
                        className="mt-3 text-xs text-slate-500 line-clamp-3 shrink-0"
                        title={fromEntry.summary}
                      >
                        摘要：{fromEntry.summary}
                      </p>
                    ) : null}
                  </>
                )}
                <div className="mt-4 pt-3 border-t border-amber-500/20 shrink-0">
                  <p className="text-xs uppercase text-slate-500 mb-2">审核操作</p>
                  {renderHarvestAuditActions()}
                  {publishMessage ? (
                    <p className="text-xs text-emerald-800 dark:text-emerald-300/90 mt-2">
                      {publishMessage}
                    </p>
                  ) : null}
                </div>
              </section>

              {/* 右栏：配置导引 */}
              <aside className="space-y-4 lg:sticky lg:top-4">
                <section className="rounded-xl border border-blue-500/30 bg-blue-500/5 dark:bg-blue-950/20 p-4">
                  <h4 className="text-sm font-semibold text-blue-800 dark:text-blue-200 mb-2">
                    配置导引
                  </h4>
                  <ul className="text-xs text-slate-600 dark:text-slate-400 space-y-2 leading-relaxed">
                    <li>确认正文无敏感、过时或与 collection 无关的内容</li>
                    <li>核对业务域、目录路径与所属 collection 是否匹配项目</li>
                    <li>
                      <strong className="text-slate-700 dark:text-slate-300">草稿</strong>
                      ：Agent 检索不会命中；{" "}
                      <strong className="text-slate-700 dark:text-slate-300">发布后</strong>
                      ：同步缓存并对外可见
                    </li>
                    <li>右侧「分类配置」可修改业务域与目录路径，点「保存分类」或「通过后发布」时一并写入</li>
                    <li>需要修改正文时，使用左栏上方「编辑」</li>
                  </ul>
                </section>
                <section className="rounded-xl border border-slate-300 dark:border-slate-600 bg-slate-100/80 dark:bg-slate-900/60 p-4 space-y-3 text-sm">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    条目配置
                  </p>
                  <div className="rounded-lg border border-blue-500/25 bg-blue-500/5 dark:bg-blue-950/30 p-3 space-y-1">
                    <p className="text-xs font-medium text-blue-800 dark:text-blue-200">
                      分类配置（审核必填）
                    </p>
                    <p className="text-[11px] text-slate-500 leading-relaxed">
                      发布后参与目录树与检索，请确认业务域与目录路径
                    </p>
                    <KbEntryMetadataFields
                      domain={entryEditForm.domain}
                      folderPath={entryEditForm.folder_path}
                      disabled={USE_MOCK_KB || !chromaDocId}
                      busy={entryManageBusy || publishBusy}
                      dirty={entryMetadataDirty(entry, entryEditForm)}
                      onDomainChange={(value) =>
                        setEntryEditForm((f) => ({ ...f, domain: value }))
                      }
                      onFolderPathChange={(value) =>
                        setEntryEditForm((f) => ({ ...f, folder_path: value }))
                      }
                      onSave={() => void saveEntryMetadata()}
                    />
                    {cacheOnlyEntry ? (
                      <p className="text-[11px] text-amber-700 dark:text-amber-300/90">
                        仅本地缓存条目，分类保存需先导入 Chroma 或删除本条
                      </p>
                    ) : null}
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 mb-0.5">发布状态</p>
                    <p
                      className={
                        entry.published === false
                          ? "text-amber-700 dark:text-amber-200 font-medium"
                          : "text-emerald-700 dark:text-emerald-200"
                      }
                    >
                      {entry.published === false ? "草稿（待审核）" : "已发布"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 mb-0.5">{fieldLabel("collection")}</p>
                    <p className="text-slate-800 dark:text-slate-200 text-sm">
                      {kbCollectionLabel(entry.collection, { projectNames: projectNameMap })}
                    </p>
                    <p className="text-xs text-slate-600 font-mono mt-0.5 break-all">
                      {entry.collection}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 mb-0.5">来源</p>
                    <p className="text-slate-700 dark:text-slate-300">{entry.source}</p>
                    {entry.source_type ? (
                      <p className="text-xs text-slate-600 mt-0.5">
                        {kbSourceTypeLabel(entry.source_type)}
                      </p>
                    ) : null}
                  </div>
                  {entry.harvested_from_user_confirmed !== undefined ? (
                    <div>
                      <p className="text-xs text-slate-500 mb-0.5">对话确认</p>
                      <p className="text-slate-700 dark:text-slate-300">
                        {entry.harvested_from_user_confirmed ? "用户已点「存入知识库」" : "否"}
                      </p>
                    </div>
                  ) : null}
                  {displayDocId ? (
                    <div>
                      <p className="text-xs text-slate-500 mb-0.5">
                        {chromaDocId ? fieldLabel("doc_id") : "缓存 ID"}
                      </p>
                      <p className="font-mono text-xs break-all text-slate-700 dark:text-slate-300">
                        {displayDocId}
                      </p>
                    </div>
                  ) : null}
                  {entry.conversation_id ? (
                    <div>
                      <p className="text-xs text-slate-500 mb-0.5">{fieldLabel("conversation_id")}</p>
                      <p className="font-mono text-xs break-all text-slate-700 dark:text-slate-300">
                        {entry.conversation_id}
                      </p>
                    </div>
                  ) : null}
                  <p className="text-xs text-slate-600 pt-1 border-t border-slate-300/60 dark:border-slate-700">
                    项目 ID：{projectId}
                  </p>
                </section>
                {entryEditing ? (
                  <section className="rounded-xl border border-slate-300 dark:border-slate-600 bg-slate-100 dark:bg-slate-900/70 p-4 space-y-3">
                    <p className="text-xs uppercase text-slate-500">发布选项</p>
                    <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                      <input
                        type="checkbox"
                        checked={entryEditForm.published}
                        onChange={(e) =>
                          setEntryEditForm((f) => ({ ...f, published: e.target.checked }))
                        }
                      />
                      保存后立即发布
                    </label>
                  </section>
                ) : null}
                {entry.projects.length > 0 ? (
                  <section className="rounded-xl border border-slate-300 dark:border-slate-600 bg-slate-100/80 dark:bg-slate-900/60 p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-2">
                      关联项目
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {entry.projects.map((pid) => (
                        <Link
                          key={pid}
                          href={`/projects/${pid}`}
                          onClick={(e) => e.stopPropagation()}
                          className="px-2.5 py-1 bg-blue-600/20 border border-blue-500/40 rounded-md text-blue-300 text-xs"
                        >
                          项目 #{pid}
                        </Link>
                      ))}
                    </div>
                  </section>
                ) : null}
              </aside>
            </div>
          ) : null}
          {!isHarvestReview ? (
            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(280px,22rem)] gap-5 items-start">
              {/* 左栏：条目内容 */}
              <section className="rounded-xl border border-slate-300 dark:border-slate-600 bg-slate-100/50 dark:bg-slate-900/40 p-4 flex flex-col min-h-[min(48vh,32rem)]">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3 shrink-0">
                  <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                    条目内容
                  </h4>
                  <span className="text-xs text-slate-500">
                    {bodyCharCount > 0 ? `${bodyCharCount} 字` : "正文为空"}
                  </span>
                </div>
                {entryEditing ? (
                  <div className="flex-1 space-y-3 overflow-y-auto min-h-0">
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
                    <label className="block text-sm flex flex-col min-h-[12rem]">
                      <span className="text-slate-400">正文（Markdown）</span>
                      <textarea
                        value={entryEditForm.content}
                        onChange={(e) =>
                          setEntryEditForm((f) => ({ ...f, content: e.target.value }))
                        }
                        className="mt-1 w-full flex-1 min-h-[12rem] rounded border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-3 py-2 text-sm font-mono"
                      />
                    </label>
                    {displayDocId ? (
                      <p className="text-xs text-slate-600 font-mono shrink-0">
                        {chromaDocId ? "doc_id" : "cache_id"}: {displayDocId}
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <>
                    {!displayBody && detailBodyLoading ? (
                      <p className="text-sm text-slate-400 py-8 text-center flex-1">
                        正在加载正文…
                      </p>
                    ) : (
                      <div className="flex-1 min-h-0 flex flex-col">
                        <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950/80 px-4 py-3">
                          <div className="prose prose-sm max-w-none dark:prose-invert text-slate-800 dark:text-slate-200">
                            <KbMarkdown assetContext={kbAssetContextFromEntry(fromEntry)}>
                              {displayBody || "—"}
                            </KbMarkdown>
                          </div>
                        </div>
                        {detailBodyLoading ? (
                          <p className="text-xs text-slate-500 mt-2 text-center shrink-0">
                            正在同步完整正文…
                          </p>
                        ) : null}
                      </div>
                    )}
                    {fromEntry.summary &&
                    fromEntry.summary !== displayBody.slice(0, 280) ? (
                      <p
                        className="mt-3 text-xs text-slate-500 line-clamp-3 shrink-0"
                        title={fromEntry.summary}
                      >
                        摘要：{fromEntry.summary}
                      </p>
                    ) : null}
                  </>
                )}
                {fromEntry.source_type === "conversation_harvest" && chromaDocId ? (
                  <div className="mt-4 pt-3 border-t border-slate-300/60 dark:border-slate-700 shrink-0">
                    <p className="text-xs uppercase text-slate-500 mb-2">草稿审核</p>
                    {renderHarvestAuditActions()}
                    {publishMessage ? (
                      <p className="text-xs text-emerald-800 dark:text-emerald-300/90 mt-2">
                      {publishMessage}
                    </p>
                    ) : null}
                  </div>
                ) : null}
              </section>

              {/* 右栏：配置导引 */}
              <aside className="space-y-4 lg:sticky lg:top-4">
                <section className="rounded-xl border border-blue-500/30 bg-blue-500/5 dark:bg-blue-950/20 p-4">
                  <h4 className="text-sm font-semibold text-blue-800 dark:text-blue-200 mb-2">
                    配置导引
                  </h4>
                  <ul className="text-xs text-slate-600 dark:text-slate-400 space-y-2 leading-relaxed">
                    <li>填写业务域与目录路径，便于左侧目录树归类</li>
                    <li>未分类条目可在列表中使用「补全分类」或导入工作区修正</li>
                    <li>绑定图谱节点后，可在知识图谱工作区追溯关联</li>
                    <li>项目 KB 集合中，仅已发布条目参与 Agent 检索</li>
                  </ul>
                </section>
                <section className="rounded-xl border border-slate-300 dark:border-slate-600 bg-slate-100/80 dark:bg-slate-900/60 p-4 space-y-3 text-sm">
                  <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    治理与元数据
                  </p>
                  <div>
                    <p className="text-xs text-slate-500 mb-0.5">来源</p>
                    <p className="text-slate-700 dark:text-slate-300">{entry.source}</p>
                    {entry.source_type ? (
                      <p className="text-xs text-slate-600 mt-0.5">
                        {kbSourceTypeLabel(entry.source_type)}
                      </p>
                    ) : null}
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 mb-1">域 / 路径</p>
                    <KbEntryMetadataFields
                      domain={entryEditForm.domain}
                      folderPath={entryEditForm.folder_path}
                      disabled={USE_MOCK_KB || !chromaDocId}
                      busy={entryManageBusy}
                      dirty={entryMetadataDirty(entry, entryEditForm)}
                      onDomainChange={(value) =>
                        setEntryEditForm((f) => ({ ...f, domain: value }))
                      }
                      onFolderPathChange={(value) =>
                        setEntryEditForm((f) => ({ ...f, folder_path: value }))
                      }
                      onSave={() => void saveEntryMetadata()}
                    />
                    {cacheOnlyEntry ? (
                      <p className="text-[11px] text-amber-700 dark:text-amber-300/90">
                        仅本地缓存，无法写入 Chroma 分类
                      </p>
                    ) : null}
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 mb-0.5">发布状态</p>
                    <p className="text-slate-700 dark:text-slate-300">
                      {entry.published === false ? "草稿（未对外检索）" : "已发布"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 mb-0.5">{fieldLabel("collection")}</p>
                    <p className="text-slate-800 dark:text-slate-200 text-sm">
                      {kbCollectionLabel(entry.collection, { projectNames: projectNameMap })}
                    </p>
                    <p className="text-xs text-slate-600 font-mono mt-0.5 break-all">
                      {entry.collection}
                    </p>
                  </div>
                  {entry.doc_id ? (
                    <div>
                      <p className="text-xs text-slate-500 mb-0.5">{fieldLabel("doc_id")}</p>
                      <p className="font-mono text-xs break-all text-slate-700 dark:text-slate-300">
                        {entry.doc_id}
                      </p>
                    </div>
                  ) : null}
                  <p className="text-xs text-slate-600 pt-1 border-t border-slate-300/60 dark:border-slate-700">
                    项目 ID：{projectId}
                  </p>
                </section>
                {entryEditing ? (
                  <section className="rounded-xl border border-slate-300 dark:border-slate-600 bg-slate-100 dark:bg-slate-900/70 p-4 space-y-3">
                    <p className="text-xs uppercase text-slate-500">发布选项</p>
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
                  </section>
                ) : null}
                <section className="rounded-xl border border-slate-300 dark:border-slate-600 bg-slate-100/80 dark:bg-slate-900/60 p-4">
                  <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">
                    关联图谱 ID（元数据）
                  </p>
                  <p className="text-slate-700 dark:text-slate-300 text-sm font-mono break-all">
                    {entry.linked_kg_ids?.length ? entry.linked_kg_ids.join(", ") : "—"}
                  </p>
                </section>
                <section className="rounded-xl border border-slate-300 dark:border-slate-600 bg-slate-100/80 dark:bg-slate-900/60 p-4">
                  <p className="text-xs text-slate-500 uppercase tracking-wide mb-2">图谱关联</p>
                  <div className="flex flex-col gap-2 mb-2">
                    <select
                      value={kgLinkKind}
                      onChange={(e) => setKgLinkKind(e.target.value)}
                      className="rounded border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-950 text-sm px-2 py-1.5 w-full"
                    >
                      {KG_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {kgKindLabel(k)}
                        </option>
                      ))}
                    </select>
                    <div className="flex gap-2">
                      <input
                        value={kgLinkNodeId}
                        onChange={(e) => setKgLinkNodeId(e.target.value)}
                        placeholder="节点 ID"
                        className="rounded border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-950 text-sm px-2 py-1.5 flex-1 min-w-0"
                      />
                      <button
                        type="button"
                        onClick={() => void addKgLink()}
                        className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-40 shrink-0"
                        disabled={USE_MOCK_KB}
                      >
                        绑定
                      </button>
                    </div>
                  </div>
                  <ul className="text-sm text-slate-400 space-y-1 max-h-32 overflow-y-auto">
                    {kgLinks.map((l) => (
                      <li key={l.id} className="flex justify-between gap-2">
                        <span className="truncate">
                          {l.kg_kind}:{l.kg_node_id}
                        </span>
                        <button
                          type="button"
                          className="text-rose-700 dark:text-rose-400 text-xs disabled:opacity-40 shrink-0"
                          disabled={USE_MOCK_KB}
                          onClick={() => void removeKgLink(l.id)}
                        >
                          移除
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
                {entry.projects.length > 0 ? (
                  <section className="rounded-xl border border-slate-300 dark:border-slate-600 bg-slate-100/80 dark:bg-slate-900/60 p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-2">
                      关联项目
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {entry.projects.map((pid) => (
                        <Link
                          key={pid}
                          href={`/projects/${pid}`}
                          onClick={(e) => e.stopPropagation()}
                          className="px-2.5 py-1 bg-blue-600/20 border border-blue-500/40 rounded-md text-blue-300 text-xs"
                        >
                          项目 #{pid}
                        </Link>
                      ))}
                    </div>
                  </section>
                ) : null}
              </aside>
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  const kbWorkspaceBody = (
    <>
      {entryManageMessage && showCreateEntry ? (
        <p className={`text-xs mb-3 whitespace-pre-wrap ${KB_TEXT_AMBER}`}>{entryManageMessage}</p>
      ) : null}
      {renderCreateEntryPanel()}
      {workspaceMode === "tree" && renderTreeWorkspace()}
      {workspaceMode === "collections" && renderCollectionWorkspace()}
      {workspaceMode === "harvest" && renderHarvestWorkspace()}
      {workspaceMode === "search" && renderSearchView()}
      {workspaceMode === "graph" && renderGraphWorkspace()}
      {workspaceMode === "ingest" && renderIngestWorkspace()}
    </>
  );

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100 p-4 text-slate-900 sm:p-6 md:p-8 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 dark:text-white">
      <div className={CONTENT_MAX_CLASS}>
        <header className="mb-8">
          <div
            className={`inline-flex items-center gap-2 rounded-full border border-emerald-400/50 bg-emerald-50 px-3 py-1 text-xs font-medium dark:border-emerald-500/30 dark:bg-emerald-500/10 ${KB_TEXT_EMERALD}`}
          >
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
                className={`rounded-xl px-4 py-2.5 text-sm font-medium transition ${KB_BTN_EMERALD}`}
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
                      : "text-slate-600 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-white dark:hover:bg-transparent"
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
                      : "text-emerald-800 hover:bg-emerald-50 dark:text-emerald-300 dark:hover:text-white dark:hover:bg-transparent"
                  }`}
                >
                  新建条目
                </button>
              ) : null}
            </div>
          </div>

          <div className="mt-6">{kbWorkspaceBody}</div>
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

