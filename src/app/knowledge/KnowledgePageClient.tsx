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
import { useRouter, useSearchParams } from "next/navigation";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, getPublicApiBase } from "@/lib/api";
import { CONTENT_MAX_CLASS } from "@/lib/content-shell";
import { KbMarkdown } from "@/components/kb-markdown";
import type { KbMarkdownAssetContext } from "@/lib/kb-markdown-assets";
import {
  KnowledgeBrowseDomain,
  KnowledgeKgDomain,
  KnowledgeTreeDomain,
} from "@/app/knowledge/components/KnowledgeDomainPanels";
import KnowledgeIngestWorkspace, {
  type KnowledgeIngestPrefill,
} from "@/app/knowledge/components/KnowledgeIngestWorkspace";
import KnowledgeAutoGovern from "@/app/knowledge/components/KnowledgeAutoGovern";
import KnowledgeCatalogPanel from "@/app/knowledge/components/KnowledgeCatalogPanel";
import KnowledgePolicyDomain from "@/app/knowledge/components/KnowledgePolicyDomain";
import { getKnowledgeQueryCache } from "@/app/knowledge/knowledge-query-cache";
import {
  fieldLabel,
  isKbCollectionHidden,
  isPublicKbCollection,
  kbCollectionScope,
  kbCollectionScopeLabel,
  kbCollectionSecondaryId,
  KB_COLLECTION_SCOPE_ORDER,
  isTpdExperienceCollection,
  isTpdExperienceEntry,
  isAuthoritativeKbCollection,
  kbCollectionDescription,
  kbCollectionLabel,
  KB_DOMAIN_LABELS,
  kbDomainLabel,
  kbFolderPathLabel,
  kbFolderSegmentLabel,
  kbSourceTypeLabel,
  kgKindLabel,
  TPD_EXPERIENCE_COLLECTION,
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
      "为启用左侧目录，请在 Chroma metadata 中填写 domain 与 folder_path。\n\n详见 docs/archive/产品1.2升级方案.md 中的 metadata 约定。",
    collection: "tech_docs",
    domain: "structured_tech",
    folder_path: "02-知识库/示例分类",
    created_at: "2026-01-15",
    projects: [],
    published: true,
  },
];

const KB_BROWSE_LIMIT = 3000;

function countUnclassifiedInTree(nodes: TreeNode[]): number {
  let count = 0;
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      for (const doc of node.documents || []) {
        const st = entryClassifyStatus({
          domain: doc.domain,
          folder_path: doc.folder_path,
        });
        if (!st.ok) count += 1;
      }
      if (node.children?.length) walk(node.children);
    }
  };
  walk(nodes);
  return count;
}

/** 需要拉取 browse 条目列表的模式（树模式仅拉 browse-tree） */
const BROWSE_ENTRY_MODES: ReadonlySet<string> = new Set([
  "collections",
  "harvest",
  "experience",
]);

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

function kgNodeSummary(row: Record<string, unknown>): { id: string; title: string; meta: string } {
  const id = String(
    row.brand_id || row.vehicle_id || row.insight_id || row.tech_id || row.planned_id || "",
  );
  const title = String(
    row.name_cn || row.name || row.vehicle_name || row.tech_category || row.narrative_theme || id || "未命名",
  );
  const meta = [row.domain, row.vehicle_type, row.tech_category, row.brand_id, row.insight_id]
    .map((item) => (item == null ? "" : String(item).trim()))
    .filter((item) => item && item !== id && item !== title)
    .slice(0, 2)
    .join(" · ");
  return { id, title, meta };
}

type SourceTypeFilter =
  | "all"
  | "conversation_harvest"
  | "tpd_experience"
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

/** 合并/去重：集合 + 逻辑 doc_id。同名文档在不同集合里各自保留。 */
function resolveDocId(entry: {
  id?: string;
  doc_id?: string;
  collection?: string;
}): string | null {
  const doc = resolveChromaDocId(entry) ?? (entry.id?.trim() || null);
  if (!doc) return null;
  const collection = entry.collection?.trim();
  return collection ? `${collection}::${doc}` : doc;
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
    const did = resolveDocId({ id: d.id, doc_id: d.doc_id, collection: d.collection }) ?? d.id;
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
  const raw = (node.path || "").trim();
  if (!raw.startsWith("scope:")) return raw;
  return raw.split("/").slice(2).join("/");
}

function collectAllTreeDocs(nodes: TreeNode[]): BrowseDoc[] {
  const out: BrowseDoc[] = [];
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      out.push(...(node.documents || []));
      if (node.children?.length) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

function recountTreeNode(node: TreeNode): number {
  const nested = (node.children || []).reduce((sum, child) => sum + recountTreeNode(child), 0);
  const total = (node.documents?.length || 0) + nested;
  node.document_count = total;
  node.total_documents = total;
  return total;
}

function insertDocByFolder(root: TreeNode, doc: BrowseDoc) {
  const parts = (doc.folder_path || "").split("/").filter(Boolean);
  let cursor = root;
  let prefix = root.path;
  for (const part of parts) {
    const path = `${prefix}/${part}`;
    let child = cursor.children.find((item) => item.path === path);
    if (!child) {
      child = {
        segment: part,
        path,
        domain: root.domain,
        documents: [],
        children: [],
        document_count: 0,
      };
      cursor.children.push(child);
    }
    cursor = child;
    prefix = path;
  }
  cursor.documents.push(doc);
}

function secondaryNodeLabel(
  scope: "internal" | "public" | "project",
  id: string,
  projectNames: Record<string, string>,
): string {
  if (id === "_uncategorized") return "未归类";
  if (scope === "project") return projectNames[id]?.trim() || "未命名项目";
  return kbDomainLabel(id);
}

/** 目录树按集合的三大类，再按业务域或项目展开目录。 */
function buildScopedBrowseTree(
  nodes: TreeNode[],
  projectNames: Record<string, string>,
): TreeNode[] {
  const docs = collectAllTreeDocs(nodes);
  const domainOrder = Object.keys(KB_DOMAIN_LABELS);
  const roots: TreeNode[] = [];
  for (const scope of KB_COLLECTION_SCOPE_ORDER) {
    const scoped = docs.filter((doc) => kbCollectionScope(doc.collection) === scope);
    if (!scoped.length) continue;
    const groups = new Map<string, BrowseDoc[]>();
    for (const doc of scoped) {
      const id = kbCollectionSecondaryId(doc.collection);
      const list = groups.get(id) ?? [];
      list.push(doc);
      groups.set(id, list);
    }
    const children = [...groups.entries()]
      .sort((a, b) => {
        const ai = domainOrder.indexOf(a[0]);
        const bi = domainOrder.indexOf(b[0]);
        if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
        return secondaryNodeLabel(scope, a[0], projectNames).localeCompare(
          secondaryNodeLabel(scope, b[0], projectNames),
          "zh",
        );
      })
      .map(([id, items]) => {
        const node: TreeNode = {
          segment: secondaryNodeLabel(scope, id, projectNames),
          path: `scope:${scope}/sec:${id}`,
          domain: scope === "project" ? undefined : id,
          documents: [],
          children: [],
          document_count: 0,
        };
        for (const doc of items) insertDocByFolder(node, doc);
        node.children.sort((a, b) => a.segment.localeCompare(b.segment, "zh"));
        recountTreeNode(node);
        return node;
      });
    const scopeNode: TreeNode = {
      segment: kbCollectionScopeLabel(scope),
      path: `scope:${scope}`,
      documents: [],
      children,
      document_count: 0,
    };
    recountTreeNode(scopeNode);
    roots.push(scopeNode);
  }
  const leftover = docs.filter((doc) => kbCollectionScope(doc.collection) === "other");
  if (leftover.length) {
    roots.push({
      segment: "未归类",
      path: "scope:other",
      documents: leftover,
      children: [],
      document_count: leftover.length,
      total_documents: leftover.length,
    });
  }
  return roots;
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

function KbClassifyRulesHint({ focus }: { focus: "tree" | "collections" }) {
  if (focus === "collections") {
    return (
      <p className="max-w-3xl text-sm leading-6 text-slate-600 dark:text-slate-400">
        <span className="font-medium text-slate-800 dark:text-slate-200">按集合查看：</span>
        文档按知识集合归组。内部名如{" "}
        <code className="text-emerald-700 dark:text-emerald-300">internal.geelywiki.pages</code>
        ，页面上显示为「内部知识库·GeelyWiki」。目录位置在「目录浏览」里按业务域和路径查看。
      </p>
    );
  }
  return (
    <p className="max-w-3xl text-sm leading-6 text-slate-600 dark:text-slate-400">
      <span className="font-medium text-slate-800 dark:text-slate-200">目录怎么排：</span>
      左侧树按业务域和目录路径展开，路径用 / 分隔。上传导入时填上这两项，或稍后补全后再刷新，文档就会出现在对应节点。
    </p>
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
function CollectionGovernPanel({
  collections,
  projectNames,
  selected,
  onSelect,
  busy,
  message,
  onClear,
  onDelete,
  projects,
  onReload,
}: {
  collections: Collection[];
  projectNames: Record<string, string>;
  selected: string;
  onSelect: (name: string) => void;
  busy: boolean;
  message: string | null;
  onClear: (name: string, label: string, count: number) => void;
  onDelete: (name: string, label: string, count: number) => void;
  projects: ProjectLite[];
  onReload: () => void;
}) {
  const [policyId, setPolicyId] = useState<string | null>(null);
  const [allowed, setAllowed] = useState<string[] | null>(null);
  const [permMessage, setPermMessage] = useState<string | null>(null);
  const [permBusy, setPermBusy] = useState(false);
  const visible = collections.filter((col) => !isKbCollectionHidden(col.name));
  const current = visible.find((col) => col.name === selected) ?? null;

  useEffect(() => {
    let cancelled = false;
    void apiGet<{ items: Array<{ id: string; status: string; config?: { write_control?: { allowed_collections?: string[] } } }> }>(
      "/kb/policies/?status=published",
    )
      .then((data) => {
        if (cancelled) return;
        const policy = data.items?.[0];
        setPolicyId(policy?.id ?? null);
        const list = policy?.config?.write_control?.allowed_collections;
        setAllowed(Array.isArray(list) ? list : null);
      })
      .catch(() => {
        if (!cancelled) setPolicyId(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const writable = !selected || allowed == null || allowed.includes(selected);

  const toggleWrite = async () => {
    if (!selected || !policyId || allowed == null) return;
    const next = writable ? allowed.filter((name) => name !== selected) : [...allowed, selected];
    setPermBusy(true);
    setPermMessage(null);
    try {
      const detail = await apiGet<{
        name: string;
        description?: string | null;
        config: Record<string, unknown>;
      }>(`/kb/policies/${encodeURIComponent(policyId)}`);
      const config = { ...(detail.config || {}) };
      const writeControl =
        config.write_control && typeof config.write_control === "object"
          ? { ...(config.write_control as Record<string, unknown>) }
          : {};
      writeControl.allowed_collections = next;
      config.write_control = writeControl;
      await apiPut(`/kb/policies/${encodeURIComponent(policyId)}`, {
        name: detail.name,
        description: detail.description,
        config,
        change_note: "更新合集写入权限",
      });
      setAllowed(next);
      setPermMessage(writable ? "已改为仅检索" : "已允许写入");
    } catch (e) {
      setPermMessage(e instanceof Error ? e.message : "权限更新失败");
    } finally {
      setPermBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900/50">
        <p className="text-sm font-medium text-slate-900 dark:text-white">合集清理与写入权限</p>
        <p className="mt-1 text-sm leading-6 text-slate-500">
          清空只删合集里的知识，合集还在。删除会先清空里面的知识，再把合集本身去掉。也可以按已发布策略切换能不能写入。
        </p>
        <label className="mt-3 block text-xs">
          <span className="text-slate-500">合集</span>
          <select
            value={selected}
            onChange={(e) => onSelect(e.target.value)}
            className="mt-1 w-full max-w-xl rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          >
            <option value="">选择合集…</option>
            {KB_COLLECTION_SCOPE_ORDER.map((scope) => {
              const items = visible.filter((col) => kbCollectionScope(col.name) === scope);
              if (!items.length) return null;
              return (
                <optgroup key={scope} label={kbCollectionScopeLabel(scope)}>
                  {items.map((col) => (
                    <option key={col.name} value={col.name}>
                      {kbCollectionLabel(col.name, { projectNames })}（{col.entry_count} 条）
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </select>
        </label>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!current || busy}
            onClick={() =>
              current &&
              onClear(
                current.name,
                kbCollectionLabel(current.name, { projectNames }),
                current.entry_count,
              )
            }
            className="rounded-lg border border-rose-400/70 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-50 disabled:opacity-40 dark:text-rose-300"
          >
            清空该合集
          </button>
          <button
            type="button"
            disabled={!current || busy}
            onClick={() =>
              current &&
              onDelete(
                current.name,
                kbCollectionLabel(current.name, { projectNames }),
                current.entry_count,
              )
            }
            className="rounded-lg bg-rose-600 px-3 py-1.5 text-sm text-white hover:bg-rose-500 disabled:opacity-40"
          >
            删除合集
          </button>
          <button
            type="button"
            disabled={!current || permBusy || !policyId || allowed == null}
            onClick={() => void toggleWrite()}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-800 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-600 dark:text-slate-200"
          >
            {writable ? "改为仅检索" : "允许写入"}
          </button>
        </div>
        {!policyId ? (
          <p className="mt-3 text-xs text-amber-800 dark:text-amber-200">
            还没有已发布策略，写入权限先不能改。清空和删除合集仍然可用。
          </p>
        ) : allowed == null ? (
          <p className="mt-3 text-xs text-slate-500">当前策略没有写入白名单，合集默认可写。</p>
        ) : current ? (
          <p className="mt-3 text-xs text-slate-500">
            {current.name}：{writable ? "允许写入" : "仅检索"}
          </p>
        ) : null}
        {permMessage ? <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">{permMessage}</p> : null}
        {message ? <p className="mt-2 text-xs text-amber-800 dark:text-amber-200">{message}</p> : null}
      </div>
      <KnowledgeCatalogPanel
        collections={visible}
        projects={projects}
        projectNames={projectNames}
        busy={busy}
        onDeleteCollection={onDelete}
        onReload={onReload}
      />
    </div>
  );
}

function KnowledgePageLinks({ current }: { current?: "ingest" | "govern" }) {
  const linkClass = (active: boolean, tone: string) =>
    `rounded-xl px-4 py-2.5 text-sm font-medium shadow-sm transition ${tone} ${
      active ? "ring-2 ring-offset-2 ring-offset-slate-50 dark:ring-offset-slate-950" : ""
    }`;
  return (
    <div className="flex flex-wrap gap-2">
      <Link
        href="/knowledge/ingest"
        aria-current={current === "ingest" ? "page" : undefined}
        className={linkClass(
          current === "ingest",
          "bg-blue-600 text-white hover:bg-blue-500 ring-blue-300 dark:ring-blue-400/80",
        )}
      >
        上传导入
      </Link>
      <Link
        href="/knowledge/govern"
        aria-current={current === "govern" ? "page" : undefined}
        className={linkClass(
          current === "govern",
          "bg-slate-900 text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white ring-slate-300 dark:ring-slate-400/80",
        )}
      >
        知识库治理
      </Link>
      <Link
        href="/learning"
        className="rounded-xl border border-violet-400/70 bg-violet-50 px-4 py-2.5 text-sm font-medium text-violet-950 transition hover:bg-violet-100 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-100 dark:hover:bg-violet-500/20"
      >
        学习中心
      </Link>
    </div>
  );
}

export default function KnowledgePageClient({
  surface = "hub",
}: {
  surface?: "hub" | "ingest" | "govern";
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [workspaceMode, setWorkspaceMode] = useState<
    | "tree"
    | "collections"
    | "search"
    | "graph"
    | "ingest"
    | "harvest"
    | "experience"
    | "policy"
  >(surface === "govern" ? "policy" : "tree");
  const [governPane, setGovernPane] = useState<"node" | "auto" | "collection" | "policy">("node");

  const [searchScopeCollection, setSearchScopeCollection] = useState<string>("");

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<KBEntry[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchSubmitted, setSearchSubmitted] = useState(false);
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
  const [treeTargetScope, setTreeTargetScope] = useState<"internal" | "public" | "project">("public");
  const [treeTargetProjectId, setTreeTargetProjectId] = useState("");
  const [treeTargetDomain, setTreeTargetDomain] = useState("structured_tech");
  const [treeTargetFolderPath, setTreeTargetFolderPath] = useState("");
  const [treeNodeDocFilter, setTreeNodeDocFilter] = useState<Set<string> | null>(null);
  const [nodeManageMessage, setNodeManageMessage] = useState<string | null>(null);
  const [showAddCategoryPanel, setShowAddCategoryPanel] = useState(false);
  const [showCollectionCategoryPanel, setShowCollectionCategoryPanel] = useState(false);
  const [collectionScope, setCollectionScope] = useState<"internal" | "public" | "project">("public");
  const [collectionDomain, setCollectionDomain] = useState("structured_tech");
  const [collectionProjectId, setCollectionProjectId] = useState("");
  const [collectionTopic, setCollectionTopic] = useState("");
  const [collectionCategoryMessage, setCollectionCategoryMessage] = useState<string | null>(null);
  const [collectionCategoryBusy, setCollectionCategoryBusy] = useState(false);
  const [governCollection, setGovernCollection] = useState("");
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
  const [ingestPrefill] = useState<KnowledgeIngestPrefill>({
    collection: "",
    domain: "structured_tech",
    folder_path: "02-知识库/导入",
    project_id: "__all__",
  });
  const [ingestPrefillNonce] = useState(0);

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
  const knowledgeQueryCacheRef = useRef(getKnowledgeQueryCache());

  const reloadCollections = useCallback(async (options?: { force?: boolean }) => {
    const force = options?.force === true;
    if (USE_MOCK_KB) {
      setCollections(MOCK_COLLECTIONS);
      return;
    }
    const colRes = await knowledgeQueryCacheRef.current.fetch(
      "browse:collections",
      () =>
        apiGet<{ collections: string[]; warning?: string }>(
          "/kb/collections?prefer_cache=1",
        ),
      { force },
    );
    const cols: Collection[] = colRes.collections.map((name) => ({
      name,
      description: name,
      entry_count: 0,
    }));
    setCollections((prev) => {
      const counts = new Map(prev.map((c) => [c.name, c.entry_count]));
      return cols.map((c) => ({
        ...c,
        entry_count: counts.get(c.name) ?? 0,
      }));
    });
  }, []);

  const reloadBrowseEntries = useCallback(async (options?: { force?: boolean }) => {
    const force = options?.force === true;
    if (USE_MOCK_KB) {
      setBrowseEntries(MOCK_ENTRIES);
      setKbLoadError(null);
      return;
    }
    try {
      setKbLoadError(null);
      const entRes = await knowledgeQueryCacheRef.current.fetch(
        `browse:entries:${KB_BROWSE_LIMIT}:lite`,
        () =>
          apiGet<{ entries: Record<string, unknown>[] }>(
            `/kb/cache/entries/__all__?limit=${KB_BROWSE_LIMIT}&include_content=false`,
          ),
        { force },
      );
      const entries = entRes.entries.map((row) => mapCacheRow(row));
      const counts = new Map<string, number>();
      for (const e of entries) {
        counts.set(e.collection, (counts.get(e.collection) ?? 0) + 1);
      }
      setBrowseEntries(entries);
      setCollections((prev) =>
        prev.map((c) => ({
          ...c,
          entry_count: counts.get(c.name) ?? 0,
        })),
      );
    } catch (e) {
      if (USE_MOCK_KB) {
        setBrowseEntries(MOCK_ENTRIES);
        setKbLoadError(null);
        return;
      }
      setKbLoadError(e instanceof Error ? e.message : "加载失败");
      setBrowseEntries([]);
    }
  }, []);

  const reloadKbBrowse = useCallback(async (options?: { force?: boolean }) => {
    const force = options?.force === true;
    if (USE_MOCK_KB) {
      setCollections(MOCK_COLLECTIONS);
      setBrowseEntries(MOCK_ENTRIES);
      setKbLoadError(null);
      return;
    }
    try {
      setKbLoadError(null);
      await Promise.all([
        reloadCollections({ force }),
        reloadBrowseEntries({ force }),
      ]);
    } catch (e) {
      setKbLoadError(e instanceof Error ? e.message : "加载失败");
    }
  }, [reloadCollections, reloadBrowseEntries]);

  const reloadBrowseTree = useCallback(async (options?: { force?: boolean }) => {
    const force = options?.force === true;
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
      const data = await knowledgeQueryCacheRef.current.fetch(
        "tree:__all__:3000",
        () =>
          apiGet<{
            domains: TreeNode[];
            truncated: boolean;
            entry_count_scanned: number;
          }>("/kb/browse-tree?project_id=__all__&limit=3000"),
        { force },
      );
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
    void reloadCollections({ force: false });
  }, [reloadCollections]);

  useEffect(() => {
    if (!BROWSE_ENTRY_MODES.has(workspaceMode)) return;
    void reloadBrowseEntries({ force: false });
  }, [workspaceMode, reloadBrowseEntries]);

  useEffect(() => {
    if (workspaceMode === "tree" || workspaceMode === "policy") {
      void reloadBrowseTree({ force: false });
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
          knowledgeQueryCacheRef.current.invalidatePrefix("browse:");
          knowledgeQueryCacheRef.current.invalidatePrefix("tree:");
          void reloadKbBrowse({ force: true });
          void reloadBrowseTree({ force: true });
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
    const nodePath = node.path || "";
    const scope = nodePath.startsWith("scope:public")
      ? "public"
      : nodePath.startsWith("scope:project")
        ? "project"
        : "internal";
    const secondary = /sec:([^/]+)/.exec(nodePath)?.[1] || "";
    setTreeTargetScope(scope);
    if (scope === "project") {
      setTreeTargetProjectId(secondary && secondary !== "_uncategorized" ? secondary : "");
    } else if (secondary && secondary !== "_uncategorized") {
      setTreeTargetDomain(secondary);
    } else {
      setTreeTargetDomain(defaultImportDomainForNode(node));
    }
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

  const scopedBrowseTree = useMemo(
    () => buildScopedBrowseTree(browseTree, projectNameMap),
    [browseTree, projectNameMap],
  );

  const unclassifiedCount = useMemo(() => {
    if (browseEntries.length > 0) {
      return browseEntries.filter(
        (e) =>
          !e.domain?.trim() ||
          e.domain === "_uncategorized" ||
          !e.folder_path?.trim(),
      ).length;
    }
    return countUnclassifiedInTree(browseTree);
  }, [browseEntries, browseTree]);

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
    if (scopedBrowseTree.length > 0 && !selectedTreeKey) {
      const first = scopedBrowseTree[0];
      if (first) {
        onTreeSelect(treeSelectionKey(first, 0, 0), first);
      }
    }
  }, [scopedBrowseTree, selectedTreeKey, onTreeSelect]);

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

  const [experiencePublishFilter, setExperiencePublishFilter] = useState<
    "draft" | "published" | "all"
  >("all");

  useEffect(() => {
    if (surface === "govern") {
      const pane = searchParams.get("pane");
      if (pane === "policy" || pane === "node" || pane === "auto" || pane === "collection") {
        setGovernPane(pane);
      }
      return;
    }
    if (surface !== "hub") return;
    const mode = searchParams.get("mode");
    if (!mode) return;
    if (mode === "experience") {
      setFilterCollection(TPD_EXPERIENCE_COLLECTION);
      setFilterSourceType("all");
      setWorkspaceMode("experience");
    } else if (mode === "harvest") {
      setFilterSourceType("conversation_harvest");
      setFilterCollection(null);
      setShowUnclassifiedOnly(false);
      setHarvestPublishFilter("draft");
      setWorkspaceMode("harvest");
    } else if (mode === "collections" || mode === "graph" || mode === "tree") {
      setWorkspaceMode(mode);
    }
    setSelectedEntry(null);
    setPage(0);
  }, [searchParams, surface]);

  const handleWorkspaceMode = (m: typeof workspaceMode) => {
    if (m === "ingest") {
      router.push("/knowledge/ingest");
      return;
    }
    if (m === "policy") {
      router.push("/knowledge/govern");
      return;
    }
    if (surface !== "hub") {
      router.push(m === "tree" ? "/knowledge" : `/knowledge?mode=${m}`);
      return;
    }
    if (m === "harvest") {
      setFilterSourceType("conversation_harvest");
      setFilterCollection(null);
      setShowUnclassifiedOnly(false);
      setHarvestPublishFilter("draft");
    } else if (m === "experience") {
      setFilterSourceType("all");
      setFilterCollection(TPD_EXPERIENCE_COLLECTION);
      setShowUnclassifiedOnly(false);
      setExperiencePublishFilter("all");
    } else if (workspaceMode === "harvest" || workspaceMode === "experience") {
      setFilterSourceType("all");
      if (workspaceMode === "experience") {
        setFilterCollection(null);
      }
    }
    if (m !== "collections") {
      setTreeNodeDocFilter(null);
    }
    setWorkspaceMode(m);
    setSelectedEntry(null);
    setPage(0);
  };

  const openKnowledgeGovern = (pane: "node" | "policy" = "node") => {
    setGovernPane(pane);
    if (surface === "govern") return;
    router.push(pane === "policy" ? "/knowledge/govern?pane=policy" : "/knowledge/govern");
  };

  const openIngestWorkspace = useCallback(
    (opts?: KnowledgeIngestPrefill) => {
      const next: KnowledgeIngestPrefill = {
        collection: opts?.collection?.trim() || "",
        domain: opts?.domain?.trim() || treeTargetDomain.trim() || "structured_tech",
        folder_path: opts?.folder_path?.trim() || treeTargetFolderPath.trim() || "02-知识库/导入",
        project_id: opts?.project_id?.trim() || ingestPrefill.project_id || "__all__",
      };
      const query = new URLSearchParams();
      if (next.collection) query.set("collection", next.collection);
      if (next.domain) query.set("domain", next.domain);
      if (next.folder_path) query.set("folder_path", next.folder_path);
      if (next.project_id) query.set("project_id", next.project_id);
      const qs = query.toString();
      router.push(qs ? `/knowledge/ingest?${qs}` : "/knowledge/ingest");
    },
    [ingestPrefill.project_id, router, treeTargetDomain, treeTargetFolderPath],
  );

  const importCollection = useMemo(() => {
    if (treeTargetScope === "project") {
      return treeTargetProjectId ? `project.${treeTargetProjectId}.kb` : "";
    }
    const prefix = `${treeTargetScope}.${treeTargetDomain}.`;
    const existing = collections.find(
      (col) => col.name.startsWith(prefix) && !isKbCollectionHidden(col.name),
    );
    return existing?.name || `${prefix}general`;
  }, [collections, treeTargetDomain, treeTargetProjectId, treeTargetScope]);

  const jumpToIngestFromTree = () => {
    openIngestWorkspace({
      collection: importCollection,
      domain: treeTargetDomain.trim() || "structured_tech",
      folder_path: treeTargetFolderPath.trim() || "02-知识库/导入",
      project_id: treeTargetScope === "project" ? treeTargetProjectId || "__all__" : "__all__",
    });
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
    const col = importCollection || pickDefaultCollection(domain);
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
    openIngestWorkspace({ domain, folder_path });
  };

  const createCollectionCategory = async () => {
    if (USE_MOCK_KB || collectionCategoryBusy) return;
    const topic = collectionTopic.trim().replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_\u4e00-\u9fff-]/g, "");
    let name = "";
    let domain = collectionDomain;
    let folder = "02-知识库/导入";
    if (collectionScope === "project") {
      if (!collectionProjectId) {
        setCollectionCategoryMessage("请选择项目。");
        return;
      }
      name = `project.${collectionProjectId}.kb`;
      domain = "structured_tech";
      folder = "项目知识库";
    } else {
      if (!topic) {
        setCollectionCategoryMessage("请填写合集标识。");
        return;
      }
      name = `${collectionScope}.${collectionDomain}.${topic}`;
      folder = collectionScope === "internal" ? "06-内部方法论" : "02-知识库";
    }
    setCollectionCategoryBusy(true);
    setCollectionCategoryMessage(null);
    try {
      await apiPost("/kb/entries/manual", {
        collection: name,
        project_id: collectionScope === "project" ? collectionProjectId : "__all__",
        title: `合集分类索引 · ${name}`,
        content: `该条目用于占位，使合集 ${name} 出现在对应分类下。`,
        domain,
        folder_path: folder,
        published: true,
        doc_id: `colcat_${topic || collectionProjectId}`,
        sync_cache: true,
      });
      setCollectionCategoryMessage(`已创建合集分类：${name}`);
      await reloadKbBrowse({ force: true });
      await reloadBrowseTree({ force: true });
    } catch (e) {
      setCollectionCategoryMessage(e instanceof Error ? e.message : "创建合集分类失败");
    } finally {
      setCollectionCategoryBusy(false);
    }
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
        project_id: ingestPrefill.project_id || "__all__",
        title: `${seg}（分类索引）`,
        content: `# ${seg}\n\n> 本条目用于在目录树中占位展示「${path}」分类，可在详情页编辑或替换为正式文档。`,
        domain,
        folder_path: path,
        published: true,
        sync_cache: true,
      });
      applyCategoryTarget(path, domain);
      setAddCategoryMessage(`已创建分类索引：${path}`);
      await reloadKbBrowse({ force: true });
      await reloadBrowseTree({ force: true });
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
    setSearchSubmitted(true);
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
      await reloadKbBrowse({ force: true });
      await reloadBrowseTree({ force: true });
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
      await reloadKbBrowse({ force: true });
      await reloadBrowseTree({ force: true });
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
      await reloadKbBrowse({ force: true });
      await reloadBrowseTree({ force: true });
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

  const confirmCollectionName = (collectionName: string, notice: string) => {
    if (!window.confirm(notice)) return "cancel" as const;
    const typed = window.prompt(
      `二次确认：请原样输入内部合集名 “${collectionName}”`,
    );
    if (typed == null) return "cancel" as const;
    if (typed.trim() !== collectionName) return "mismatch" as const;
    return "ok" as const;
  };

  const deleteCollectionAll = async (collectionName: string, label: string, count: number) => {
    if (USE_MOCK_KB || entryManageBusy) return;
    const gate = confirmCollectionName(
      collectionName,
      `确定清空合集「${label}」下的全部内容？\n约 ${count} 条缓存 / 全部 Chroma chunk，合集本身会保留，内容不可恢复。`,
    );
    if (gate === "cancel") return;
    if (gate === "mismatch") {
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
      await reloadKbBrowse({ force: true });
      await reloadBrowseTree({ force: true });
      setEntryManageMessage(`已清空合集内容：${label}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "合集删除失败";
      setEntryManageMessage(msg.includes("404") ? "合集删除接口不可用，请重启后端。" : msg);
    } finally {
      setEntryManageBusy(false);
    }
  };

  const deleteCollectionEntity = async (collectionName: string, label: string, count: number) => {
    if (USE_MOCK_KB || entryManageBusy) return;
    const gate = confirmCollectionName(
      collectionName,
      `确定删除合集「${label}」？\n会先清空其中约 ${count} 条知识，再删除合集本身，不可恢复。`,
    );
    if (gate === "cancel") return;
    if (gate === "mismatch") {
      setEntryManageMessage("合集名不匹配，已取消删除。");
      return;
    }
    setEntryManageBusy(true);
    setEntryManageMessage(null);
    try {
      await apiDelete(
        `/kb/collections/${encodeURIComponent(collectionName)}?confirm=true&project_id=__all__`,
      );
      if (selectedEntry?.collection === collectionName) {
        setSelectedEntry(null);
        setEntryEditing(false);
      }
      if (filterCollection === collectionName) {
        setFilterCollection(null);
      }
      if (governCollection === collectionName) {
        setGovernCollection("");
      }
      setTreeNodeDocFilter(null);
      setCollections((prev) => prev.filter((col) => col.name !== collectionName));
      await reloadKbBrowse({ force: true });
      await reloadBrowseTree({ force: true });
      setEntryManageMessage(`已删除合集：${label}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "合集删除失败";
      if (msg.includes("collection_drop_failed")) {
        setEntryManageMessage("合集内容已清空，但删除合集本身失败。可以再试一次删除。");
      } else if (msg.includes("404")) {
        setEntryManageMessage("删除合集接口不可用，请重启后端。");
      } else {
        setEntryManageMessage(msg);
      }
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
        project_id: ingestPrefill.project_id || "__all__",
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
      await reloadKbBrowse({ force: true });
      await reloadBrowseTree({ force: true });
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
      const concreteProject = projectId && !["__all__", "*", "all"].includes(projectId);
      setPublishMessage(
        published
          ? concreteProject
            ? "已通过审批，并沉淀到该项目的知识库。"
            : "已发布。这条没有关联项目，所以没有归入项目知识库。"
          : "已保持草稿（未对外发布）。",
      );
      await reloadKbBrowse({ force: true });
      await reloadBrowseTree({ force: true });
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
    if (filterSourceType === "tpd_experience") return isTpdExperienceEntry(e);
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

  const experienceAllEntries = useMemo(
    () => dedupeKbEntriesByDocId(browseEntries.filter((e) => isTpdExperienceEntry(e))),
    [browseEntries],
  );

  const experienceStats = useMemo(() => {
    const draft = experienceAllEntries.filter((e) => e.published !== true);
    const published = experienceAllEntries.filter((e) => e.published === true);
    return {
      total: experienceAllEntries.length,
      draft: draft.length,
      published: published.length,
    };
  }, [experienceAllEntries]);

  const experienceVisibleEntries = useMemo(() => {
    if (experiencePublishFilter === "draft") {
      return experienceAllEntries.filter((e) => e.published !== true);
    }
    if (experiencePublishFilter === "published") {
      return experienceAllEntries.filter((e) => e.published === true);
    }
    return experienceAllEntries;
  }, [experienceAllEntries, experiencePublishFilter]);
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

  const loadKgPanel = async (options?: { force?: boolean }) => {
    const force = options?.force !== false;
    setKgBusy(true);
    try {
      const stats = await knowledgeQueryCacheRef.current.fetch(
        "kg:stats",
        () => apiGet<Record<string, unknown>>("/kg/stats"),
        { force },
      );
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

  const loadKgNodes = async (options?: { force?: boolean }) => {
    const force = options?.force !== false;
    setKgBusy(true);
    try {
      const r = await knowledgeQueryCacheRef.current.fetch(
        `kg:nodes:${kgKindPick}`,
        () =>
          apiGet<{ items: Record<string, unknown>[] }>(
            `/kg/nodes/${encodeURIComponent(kgKindPick)}?limit=200`,
          ),
        { force },
      );
      setKgNodes(r.items || []);
    } catch {
      setKgNodes([]);
    } finally {
      setKgBusy(false);
    }
  };

  const loadKgRels = async (options?: { force?: boolean }) => {
    const force = options?.force !== false;
    setKgBusy(true);
    try {
      const r = await knowledgeQueryCacheRef.current.fetch(
        "kg:relations",
        () =>
          apiGet<{ items: Record<string, unknown>[] }>(
            "/kg/relations?limit=200",
          ),
        { force },
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
      void loadKgPanel({ force: false });
      void loadKgNodes({ force: false });
      void loadKgRels({ force: false });
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
      knowledgeQueryCacheRef.current.invalidatePrefix("kg:");
      await loadKgPanel({ force: true });
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
      knowledgeQueryCacheRef.current.invalidatePrefix("kg:");
      await loadKgRels({ force: true });
      await loadKgPanel({ force: true });
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
              {(() => {
                const scope = kbCollectionScope(d.collection);
                const scopeLabel = scope === "other" ? "未归类" : kbCollectionScopeLabel(scope);
                const secondaryId = kbCollectionSecondaryId(d.collection);
                const secondary =
                  scope === "other"
                    ? kbCollectionLabel(d.collection, { projectNames: projectNameMap })
                    : scope === "project"
                      ? projectNameMap[secondaryId]?.trim() || "未命名项目"
                      : kbDomainLabel(secondaryId);
                const folder = kbFolderPathLabel(d.folder_path);
                return [scopeLabel, secondary, folder].filter(Boolean).join(" · ");
              })()}
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
    {selectedTreeNode ? (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900/40">
        <span className="text-slate-500">当前节点</span>
        <span className="font-medium text-slate-900 dark:text-white">
          {selectedTreeNode.domain
            ? kbDomainLabel(selectedTreeNode.domain)
            : selectedTreeNode.segment || "当前节点"}
        </span>
        <span className="font-mono text-xs text-slate-600 dark:text-slate-300">
          {kbFolderPathLabel(selectedTreeFolderPath) || "域根"}
        </span>
        <span className="text-xs text-slate-500">{treeNodeStats.subtreeCount} 篇</span>
        {treeNodeStats.unclassifiedCount > 0 ? (
          <span className={`text-xs font-medium ${KB_TEXT_AMBER}`}>
            未分类 {treeNodeStats.unclassifiedCount}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => openKnowledgeGovern("node")}
          className="ml-auto rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
        >
          在知识库治理中处理
        </button>
      </div>
    ) : (
      <p className="text-sm text-slate-500">选择左侧目录后，可在知识库治理里调整落点和导入目标。</p>
    )}
    <div className="grid gap-4 lg:grid-cols-12 min-h-[480px]">
      <div className="lg:col-span-4 rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-200/40 dark:bg-slate-800/40 p-3 overflow-auto max-h-[70vh]">
        <p className="text-xs text-slate-400 mb-2 font-medium">知识库 / 业务域 / 目录</p>
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
            nodes={scopedBrowseTree}
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
        <div className="lg:col-span-8 grid gap-4 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-start min-w-0">
          <div className="min-w-0">{treeDocListPanel}</div>
          <div className="min-w-0 max-h-[min(85vh,calc(100vh-8rem))] overflow-y-auto lg:sticky lg:top-4">
            {renderDetailPanel(selectedEntry)}
          </div>
        </div>
      ) : (
        <div className="lg:col-span-8">{treeDocListPanel}</div>
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
            {isTpdExperienceEntry(entry) ? (
              <span className="text-xs px-2 py-1 rounded font-medium bg-violet-500/20 text-violet-800 dark:text-violet-200 border border-violet-500/30">
                经验库
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
                openIngestWorkspace({
                  domain:
                    entry.domain && entry.domain !== "_uncategorized"
                      ? entry.domain
                      : "structured_tech",
                  folder_path: entry.folder_path || "02-知识库/导入",
                  collection: entry.collection,
                });
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
            onClick={() => void reloadKbBrowse({ force: true })}
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

  const renderExperienceWorkspace = () => {
    const rows =
      experienceVisibleEntries.length > 0
        ? experienceVisibleEntries
        : USE_MOCK_KB
          ? MOCK_ENTRIES.filter((e) => isTpdExperienceEntry(e))
          : [];

    return (
      <div>
        {kbLoadError && (
          <p className="text-sm text-amber-400 mb-3">知识库数据加载异常：{kbLoadError}</p>
        )}
        <div className="mb-4 rounded-lg border border-violet-500/30 bg-violet-500/5 px-4 py-3 text-sm">
          <p className="font-medium text-violet-900 dark:text-violet-100">TPD 经验库</p>
          <p className="text-xs text-slate-500 mt-1">
            来自对话 👍/「采纳」的结构化经验，集合{" "}
            <code className="text-violet-700 dark:text-violet-300">{TPD_EXPERIENCE_COLLECTION}</code>
            。可在{" "}
            <Link href="/learning" className="text-blue-600 hover:underline dark:text-blue-400">
              学习中心
            </Link>{" "}
            查看索引与溯源。
          </p>
        </div>
        <div className="flex flex-wrap gap-2 mb-4 items-center">
          <button
            type="button"
            onClick={() => void reloadKbBrowse({ force: true })}
            className="rounded-lg border border-slate-300 dark:border-slate-600 px-3 py-1.5 text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:bg-slate-800"
          >
            刷新
          </button>
          {(
            [
              ["all", "全部", experienceStats.total],
              ["draft", "草稿", experienceStats.draft],
              ["published", "已发布", experienceStats.published],
            ] as const
          ).map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                setExperiencePublishFilter(key);
                setPage(0);
              }}
              className={`px-4 py-2 rounded-lg text-sm border transition ${
                experiencePublishFilter === key
                  ? "bg-violet-600 border-violet-500 text-white"
                  : "bg-slate-200 dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300"
              }`}
            >
              {label} ({count})
            </button>
          ))}
        </div>
        <KbEntryListDetailSplit
          list={
            <div className="space-y-3">
              {rows.length === 0 && (
                <p className="text-slate-500 text-center py-12 text-sm">
                  {experienceStats.total === 0
                    ? "暂无经验条目。请在对话中对助手回复点击 👍 或「采纳」。"
                    : "当前筛选下无条目。"}
                </p>
              )}
              {rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((entry) =>
                renderBrowseEntryRow(entry),
              )}
            </div>
          }
          detail={selectedEntry ? renderDetailPanel(selectedEntry) : null}
        />
      </div>
    );
  };

  const renderCollectionWorkspace = () => {
    const cols = (collections.length > 0 ? collections : MOCK_COLLECTIONS).filter(
      (c) => !isKbCollectionHidden(c.name),
    );
    const domainOrder = Object.keys(KB_DOMAIN_LABELS);
    const groupedCols = KB_COLLECTION_SCOPE_ORDER.map((scope) => {
      const inScope = cols.filter((c) => kbCollectionScope(c.name) === scope);
      const bySecondary = new Map<string, Collection[]>();
      for (const col of inScope) {
        const secondary = kbCollectionSecondaryId(col.name);
        const list = bySecondary.get(secondary) ?? [];
        list.push(col);
        bySecondary.set(secondary, list);
      }
      const sections = [...bySecondary.entries()]
        .map(([id, items]) => ({
          id,
          label:
            id === "_uncategorized"
              ? "未归类"
              : scope === "project"
                ? projectNameMap[id]?.trim() || "未命名项目"
                : kbDomainLabel(id),
          cols: items.sort((a, b) =>
            kbCollectionLabel(a.name, { projectNames: projectNameMap }).localeCompare(
              kbCollectionLabel(b.name, { projectNames: projectNameMap }),
              "zh",
            ),
          ),
        }))
        .sort((a, b) => {
          const ai = domainOrder.indexOf(a.id);
          const bi = domainOrder.indexOf(b.id);
          if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
          return a.label.localeCompare(b.label, "zh");
        });
      return { scope, label: kbCollectionScopeLabel(scope), sections };
    });
    const otherCols = cols.filter((c) => kbCollectionScope(c.name) === "other");
    const rawRows =
      visibleBrowseEntries.length > 0
        ? visibleBrowseEntries
        : USE_MOCK_KB
          ? MOCK_ENTRIES
          : [];
    const rows = dedupeKbEntriesByDocId(rawRows);

    const renderColButton = (col: Collection) => {
      const label = kbCollectionLabel(col.name, { projectNames: projectNameMap });
      const desc = kbCollectionDescription(col.name);
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
          title={desc ? `${col.name}\n${desc}` : col.name}
        >
          <span className={`block font-medium ${active ? "text-white" : "text-slate-900 dark:text-white"}`}>
            {label}
            {isAuthoritativeKbCollection(col.name) ? (
              <span className="ml-1.5 inline-block rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-normal text-emerald-700 dark:text-emerald-300">
                真源
              </span>
            ) : null}
            {isTpdExperienceCollection(col.name) ? (
              <span className="ml-1.5 inline-block rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-normal text-violet-700 dark:text-violet-300">
                经验库
              </span>
            ) : null}
          </span>
          <span className={`text-xs font-mono ${active ? "text-blue-100" : "text-slate-400"}`}>{col.name}</span>
          <span className={`mt-0.5 block text-xs ${active ? "text-blue-100" : "text-slate-400"}`}>({col.entry_count} 条)</span>
        </button>
      );
    };

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
          <KbClassifyRulesHint focus="collections" />
        </div>
        <div className="flex flex-wrap gap-2 mb-4 items-center">
          <button
            type="button"
            onClick={() => void reloadKbBrowse({ force: true })}
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
        <div className="mb-6 space-y-4">
          {groupedCols.map((group) => (
            <section
              key={group.scope}
              className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4 dark:border-slate-700 dark:bg-slate-900/40"
            >
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white">{group.label}</h3>
              {group.sections.length === 0 ? (
                <p className="mt-2 text-xs text-slate-500">暂无集合</p>
              ) : (
                <div className="mt-3 space-y-3">
                  {group.sections.map((section) => (
                    <div key={section.id}>
                      <p className="mb-2 text-xs text-slate-500">{section.label}</p>
                      <div className="flex flex-wrap gap-2">{section.cols.map(renderColButton)}</div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          ))}
          {otherCols.length > 0 ? (
            <section className="rounded-2xl border border-dashed border-slate-300 p-4 dark:border-slate-600">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white">未归类</h3>
              <p className="mt-1 text-xs text-slate-500">名称不以 internal / public / project 开头，暂不归入三大类。</p>
              <div className="mt-3 flex flex-wrap gap-2">{otherCols.map(renderColButton)}</div>
            </section>
          ) : null}
        </div>
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
              <option value="tpd_experience">经验库</option>
              <option value="file">文件导入</option>
              <option value="upload">上传导入</option>
            </select>
            {filterCollection ? (
              <button
                type="button"
                onClick={() => handleWorkspaceMode("tree")}
                className="text-xs text-blue-400 hover:text-blue-300"
              >
                在目录树中浏览 →
              </button>
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
                      : "暂无条目。可在外部 KB 同步后刷新，或使用上方搜索。"}
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
          <>
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {Object.entries(nodesBlock).map(([k, v]) => (
                <div key={k} className="rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-200 dark:bg-slate-800/50 p-3">
                  <p className="text-xs text-slate-500">{kgKindLabel(k)}</p>
                  <p className="text-xl font-semibold text-slate-900 dark:text-white">{v}</p>
                </div>
              ))}
              <div className="rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-200 dark:bg-slate-800/50 p-3">
                <p className="text-xs text-slate-500">关系</p>
                <p className="text-xl font-semibold text-slate-900 dark:text-white">
                  {Number(kgStats?.relations_explicit ?? 0)}
                </p>
              </div>
            </div>
            {Object.values(nodesBlock).every((v) => Number(v) === 0) &&
            Number(kgStats?.relations_explicit ?? 0) === 0 ? (
              <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
                图谱库是空的，所以这里看不到结构和数据。品牌、车型、技术洞察、核心技术、规划车型都还没有入库。
                「校验：通过」只表示没有悬空关系。目录浏览里的文档在另一套知识库里，不会自动出现在这张图上。
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-slate-500 text-sm">统计还没读到。刷新后如果仍是空的，说明图谱库没有实体。</p>
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
            <div className="max-h-72 overflow-auto rounded-lg border border-slate-300 dark:border-slate-700">
              {kgNodes.length === 0 ? (
                <p className="p-3 text-sm text-slate-500">
                  {kgKindLabel(kgKindPick)}还没有数据。换一个类型，或先在上方导入。
                </p>
              ) : (
                <ul className="divide-y divide-slate-200 dark:divide-slate-800">
                  {kgNodes.map((row, i) => {
                    const item = kgNodeSummary(row);
                    return (
                      <li key={item.id || i} className="px-3 py-2">
                        <p className="text-sm font-medium text-slate-900 dark:text-white">{item.title}</p>
                        <p className="mt-0.5 font-mono text-[11px] text-slate-500">
                          {item.id}
                          {item.meta ? ` · ${item.meta}` : ""}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              )}
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
      (fromEntry.source_type === "conversation_harvest" ||
        fromEntry.source_type === "tpd_experience" ||
        isTpdExperienceEntry(fromEntry)) &&
      chromaDocId ? (
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

  const renderNodeGovernPanel = () => {
    if (treeLoading && !selectedTreeNode) {
      return <p className="text-sm text-slate-500">正在读取目录…</p>;
    }
    if (!selectedTreeNode) {
      return (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-6 py-10 text-center dark:border-slate-700 dark:bg-slate-900/40">
          <p className="text-sm font-medium text-slate-900 dark:text-white">还没有选中目录节点</p>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">
            先在目录浏览里点一个业务域或文件夹，再回到这里设置导入目标、补分类或复制路径。
          </p>
          <button
            type="button"
            onClick={() => handleWorkspaceMode("tree")}
            className="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900"
          >
            去目录浏览
          </button>
        </div>
      );
    }

    const stats = [
      ["本级文档", treeNodeStats.directCount, "text-slate-900 dark:text-white"],
      ["含子目录", treeNodeStats.subtreeCount, "text-slate-900 dark:text-white"],
      ["子文件夹", treeNodeStats.childFolderCount, "text-slate-900 dark:text-white"],
      ["草稿", treeNodeStats.draftCount, KB_TEXT_AMBER],
      ["未完整分类", treeNodeStats.unclassifiedCount, KB_TEXT_AMBER],
    ] as const;

    return (
      <div className="space-y-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900/50">
          <p className="text-xs text-slate-500">当前节点</p>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
              {kbDomainLabel(selectedTreeNode.domain)}
            </h3>
            {selectedTreeNode.domain ? (
              <span className="font-mono text-xs text-slate-500">{selectedTreeNode.domain}</span>
            ) : null}
          </div>
          <p className="mt-1 break-all font-mono text-sm text-slate-700 dark:text-slate-200">
            {kbFolderPathLabel(selectedTreeFolderPath) || "域根 · 条目可能还没有目录路径"}
          </p>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            {stats.map(([label, value, tone]) => (
              <div
                key={label}
                className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-950/40"
              >
                <p className="text-[11px] text-slate-500">{label}</p>
                <p className={`mt-1 text-xl font-semibold ${tone}`}>{value}</p>
              </div>
            ))}
          </div>
          {treeNodeStats.collectionCounts.length > 0 ? (
            <div className="mt-4">
              <p className="text-xs text-slate-500">涉及集合</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {treeNodeStats.collectionCounts.slice(0, 8).map((c) => (
                  <button
                    key={c.name}
                    type="button"
                    title={c.name}
                    onClick={() => jumpToCollectionFromDoc(c.name)}
                    className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                  >
                    {kbCollectionLabel(c.name, { projectNames: projectNameMap })} ({c.count})
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900/50">
            <p className="text-sm font-medium text-slate-900 dark:text-white">导入 / 新建目标</p>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              知识库决定创作时搜哪一类合集，业务域决定策略能不能用到这篇，目录决定人在树里的位置。
            </p>
            <label className="mt-3 block text-xs">
              <span className="text-slate-500">知识库</span>
              <select
                value={treeTargetScope}
                onChange={(e) =>
                  setTreeTargetScope(e.target.value as "internal" | "public" | "project")
                }
                className="mt-1 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
              >
                <option value="internal">内部知识库</option>
                <option value="public">公共知识库</option>
                <option value="project">项目知识库</option>
              </select>
            </label>
            {treeTargetScope === "project" ? (
              <label className="mt-3 block text-xs">
                <span className="text-slate-500">项目</span>
                <select
                  value={treeTargetProjectId}
                  onChange={(e) => setTreeTargetProjectId(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
                >
                  <option value="">选择项目…</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="mt-3 block text-xs">
              <span className="text-slate-500">业务域</span>
              <select
                value={treeTargetDomain}
                onChange={(e) => setTreeTargetDomain(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
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
            <label className="mt-3 block text-xs">
              <span className="text-slate-500">目录路径</span>
              <input
                value={treeTargetFolderPath}
                onChange={(e) => setTreeTargetFolderPath(e.target.value)}
                placeholder="如 02-知识库/子目录"
                className="mt-1 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-sm dark:border-slate-700 dark:bg-slate-950"
              />
            </label>
            <p className="mt-3 break-all font-mono text-[11px] text-slate-500">
              {importCollection
                ? `写入合集 ${importCollection}`
                : "选择项目后才会写入项目知识库"}
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900/50">
            <p className="text-sm font-medium text-slate-900 dark:text-white">可执行操作</p>
            {(selectedTreeNode.children?.length ?? 0) > 0 ? (
              <div className="mt-3">
                <p className="text-xs text-slate-500">子目录</p>
                <div className="mt-2 flex max-h-24 flex-wrap gap-1 overflow-auto">
                  {selectedTreeNode.children!.map((ch, i) => {
                    const key = treeSelectionKey(ch, 1, i);
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => onTreeSelect(key, ch)}
                        className="rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
                      >
                        {ch.segment || "子目录"} ({ch.document_count ?? 0})
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={jumpToIngestFromTree}
                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
              >
                导入到此目录
              </button>
              {!USE_MOCK_KB ? (
                <button
                  type="button"
                  onClick={() => jumpToCreateFromTree()}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
                >
                  新建条目
                </button>
              ) : null}
              <button
                type="button"
                onClick={jumpToCollectionsForNode}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-800 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                在集合中管理
              </button>
              <button
                type="button"
                onClick={() => void copyTreeFolderPath()}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-800 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                复制路径
              </button>
              {treeNodeStats.draftCount > 0 ? (
                <button
                  type="button"
                  onClick={() => {
                    setTreeDocScope("draft");
                    setTreeDocQuery("");
                    handleWorkspaceMode("tree");
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
                    handleWorkspaceMode("tree");
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
              <p className="mt-3 text-xs text-slate-500">{nodeManageMessage}</p>
            ) : null}
          </div>
        </div>
      </div>
    );
  };

  const kbWorkspaceBody = (
    <>
      {workspaceMode === "tree" && (
        <KnowledgeTreeDomain>{renderTreeWorkspace()}</KnowledgeTreeDomain>
      )}
      {(workspaceMode === "collections" ||
        workspaceMode === "harvest" ||
        workspaceMode === "experience") && (
        <KnowledgeBrowseDomain
          workspaceMode={workspaceMode}
          entryManageMessage={
            entryManageMessage && showCreateEntry ? (
              <p className={`text-xs mb-3 whitespace-pre-wrap ${KB_TEXT_AMBER}`}>
                {entryManageMessage}
              </p>
            ) : null
          }
          createEntryPanel={renderCreateEntryPanel()}
          renderCollectionWorkspace={renderCollectionWorkspace}
          renderHarvestWorkspace={renderHarvestWorkspace}
          renderExperienceWorkspace={renderExperienceWorkspace}
          renderSearchView={() => null}
        />
      )}
      {workspaceMode === "graph" && <KnowledgeKgDomain>{renderGraphWorkspace()}</KnowledgeKgDomain>}
    </>
  );

  const ingestQueryPrefill = useMemo<KnowledgeIngestPrefill>(
    () => ({
      collection: searchParams.get("collection") || "",
      domain: searchParams.get("domain") || "structured_tech",
      folder_path: searchParams.get("folder_path") || "02-知识库/导入",
      project_id: searchParams.get("project_id") || "__all__",
    }),
    [searchParams],
  );

  const governBody = (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">目录与策略</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500">
            目录节点决定文档落在哪个业务域和路径；策略决定检索范围和写入白名单。
          </p>
        </div>
        <div className="flex gap-1 rounded-lg border border-slate-300 bg-slate-100 p-1 dark:border-slate-700 dark:bg-slate-800/60">
          {(
            [
              ["node", "目录节点"],
              ["auto", "自动治理"],
              ["collection", "合集管理"],
              ["policy", "策略"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setGovernPane(key)}
              className={`rounded-md px-4 py-2 text-sm font-medium transition ${
                governPane === key
                  ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900"
                  : "text-slate-600 hover:bg-white dark:text-slate-300 dark:hover:bg-slate-900"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {renderCreateEntryPanel()}
      {governPane === "node" ? (
        renderNodeGovernPanel()
      ) : governPane === "auto" ? (
        <KnowledgeAutoGovern
          onCompleted={() => {
            knowledgeQueryCacheRef.current.invalidatePrefix("browse:");
            knowledgeQueryCacheRef.current.invalidatePrefix("tree:");
            void reloadBrowseTree({ force: true });
            void reloadKbBrowse({ force: true });
          }}
        />
      ) : governPane === "collection" ? (
        <CollectionGovernPanel
          collections={collections}
          projectNames={projectNameMap}
          selected={governCollection}
          onSelect={setGovernCollection}
          busy={entryManageBusy}
          message={entryManageMessage}
          onClear={(name, label, count) => void deleteCollectionAll(name, label, count)}
          onDelete={(name, label, count) => void deleteCollectionEntity(name, label, count)}
          projects={projects}
          onReload={() => {
            void reloadKbBrowse({ force: true });
            void reloadBrowseTree({ force: true });
          }}
        />
      ) : (
        <KnowledgePolicyDomain active={surface === "govern" && governPane === "policy"} embedded />
      )}
    </div>
  );

  if (surface === "ingest") {
    return (
      <main className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100 p-4 text-slate-900 sm:p-6 md:p-8 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 dark:text-white">
        <div className={CONTENT_MAX_CLASS}>
          <header className="mb-8">
            <Link href="/knowledge" className="text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
              返回知识库
            </Link>
            <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h1 className="text-3xl font-bold sm:text-4xl">上传导入</h1>
                <p className="mt-2 max-w-2xl text-sm text-slate-500 sm:text-base">
                  上传或批量导入文档，自动抽取正文后写入知识库并回填缓存。
                </p>
              </div>
              <KnowledgePageLinks current="ingest" />
            </div>
          </header>
          <KBDegradedBanner />
          <section className="rounded-3xl border border-slate-200 bg-white/80 p-6 dark:border-slate-800 dark:bg-slate-900/50">
            <KnowledgeIngestWorkspace
              useMock={USE_MOCK_KB}
              prefill={ingestQueryPrefill}
              prefillNonce={ingestPrefillNonce}
              onCompleted={() => {
                knowledgeQueryCacheRef.current.invalidatePrefix("browse:");
                knowledgeQueryCacheRef.current.invalidatePrefix("tree:");
              }}
            />
          </section>
        </div>
      </main>
    );
  }

  if (surface === "govern") {
    return (
      <main className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100 p-4 text-slate-900 sm:p-6 md:p-8 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 dark:text-white">
        <div className={CONTENT_MAX_CLASS}>
          <header className="mb-8">
            <Link href="/knowledge" className="text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
              返回知识库
            </Link>
            <div className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <h1 className="text-3xl font-bold sm:text-4xl">知识库治理</h1>
                <p className="mt-2 max-w-2xl text-sm text-slate-500 sm:text-base">
                  管理目录落点和检索策略，与知识浏览分开。
                </p>
              </div>
              <KnowledgePageLinks current="govern" />
            </div>
          </header>
          <KBDegradedBanner />
          <section className="rounded-3xl border border-slate-200 bg-white/80 p-6 dark:border-slate-800 dark:bg-slate-900/50">
            {governBody}
          </section>
        </div>
      </main>
    );
  }

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
                公共知识库按<strong className="text-slate-800 dark:text-slate-200">目录树</strong>
                浏览，<strong className="text-slate-800 dark:text-slate-200">知识图谱</strong>
                看信息点。目录落点和检索策略在
                <strong className="text-slate-800 dark:text-slate-200">知识库治理</strong>。
              </p>
            </div>
            <KnowledgePageLinks />
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

        <div className="mb-4 rounded-2xl border border-slate-200 bg-white/80 px-4 py-3 dark:border-slate-800 dark:bg-slate-900/50">
          <p className="mb-2 text-xs text-slate-500">
            默认跨全部知识集合检索（/kb/query-all）；可选限定其一。
          </p>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <select
              value={searchScopeCollection}
              onChange={(e) => setSearchScopeCollection(e.target.value)}
              aria-label="检索知识集合"
              className="w-full shrink-0 rounded-lg border border-slate-300 bg-slate-100 px-3 py-2 text-sm text-slate-900 sm:max-w-md dark:border-slate-700 dark:bg-slate-900 dark:text-white"
            >
              <option value="">全部知识集合</option>
              {(collections.length ? collections : MOCK_COLLECTIONS).map((c) => (
                <option key={c.name} value={c.name}>
                  {kbCollectionLabel(c.name, { projectNames: projectNameMap })}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => {
                const next = e.target.value;
                setSearchQuery(next);
                if (!next.trim()) {
                  setSearchSubmitted(false);
                  setSearchResults([]);
                }
              }}
              onKeyDown={(e) => e.key === "Enter" && void handleSearch()}
              placeholder="输入关键词搜索知识库..."
              aria-label="搜索知识库"
              className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-slate-200 px-4 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-800 dark:text-white dark:placeholder-slate-500"
            />
            <button
              type="button"
              onClick={() => void handleSearch()}
              disabled={isSearching || !searchQuery.trim()}
              className="shrink-0 rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {isSearching ? "搜索中..." : "搜索"}
            </button>
          </div>
          {searchSubmitted ? <div className="mt-4">{renderSearchView()}</div> : null}
        </div>

        <section id="kb-workspace" className="rounded-3xl border border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900/50 p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500">知识工作台</p>
              <h2 className="mt-2 text-xl font-semibold text-slate-900 dark:text-white">目录 · 集合 · 检索 · 图谱</h2>
            </div>
            <div className="flex flex-wrap gap-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-200/60 dark:bg-slate-800/60 p-1">
              {(
                [
                  ["tree", "目录浏览"],
                  ["collections", "按集合"],
                  ["harvest", "对话收割"],
                  ["experience", "经验库"],
                  ["graph", "知识图谱"],
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
