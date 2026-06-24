import { isInternalSectionCollection } from "@/lib/kb-collection-catalog";
import type { AssistantFileToolEvent } from "@/app/chat/chat-types";

export interface CitationSource {
  ref: number;
  chunkId: string;
  docId?: string;
  title: string;
  collection: string;
  excerpt: string;
  chunkIndex?: number;
  chunkCount?: number;
  distance?: number;
  /** kb=知识库，web=互联网检索 */
  sourceKind?: "kb" | "web";
  url?: string;
}

export function isWebCitationSource(source: Pick<CitationSource, "sourceKind" | "collection">): boolean {
  return source.sourceKind === "web" || source.collection === "互联网";
}

/** 引用角标 / 来源列表分区：内部真源 → 公共知识库 → 互联网 */
export type CitationScopeKind = "internal" | "public_kb" | "web";

const CITATION_SCOPE_SORT_RANK: Record<CitationScopeKind, number> = {
  internal: 0,
  public_kb: 1,
  web: 2,
};

export function citationScopeKind(
  source: Pick<CitationSource, "sourceKind" | "collection">,
): CitationScopeKind {
  if (isWebCitationSource(source)) return "web";
  const col = source.collection.trim();
  if (col.startsWith("internal.") || isInternalSectionCollection(col)) {
    return "internal";
  }
  return "public_kb";
}

export function sortCitationsByScope(citations: CitationSource[]): CitationSource[] {
  return [...citations].sort((a, b) => {
    const rankA = CITATION_SCOPE_SORT_RANK[citationScopeKind(a)];
    const rankB = CITATION_SCOPE_SORT_RANK[citationScopeKind(b)];
    if (rankA !== rankB) return rankA - rankB;
    return a.ref - b.ref;
  });
}

export function citationBadgeClassName(
  scope: CitationScopeKind,
  unresolved?: boolean,
): string {
  if (unresolved) {
    return "bg-amber-200 text-amber-900 hover:bg-amber-300 dark:bg-amber-900/60 dark:text-amber-100";
  }
  switch (scope) {
    case "internal":
      return "bg-blue-700 text-blue-50 hover:bg-blue-800 dark:bg-blue-950 dark:text-blue-100";
    case "web":
      return "bg-emerald-200/90 text-emerald-900 hover:bg-emerald-300 dark:bg-emerald-900/70 dark:text-emerald-100";
    case "public_kb":
    default:
      return "bg-blue-200/90 text-blue-900 hover:bg-blue-300 dark:bg-blue-900/70 dark:text-blue-100";
  }
}

export function citationListTagClassName(scope: CitationScopeKind): string {
  switch (scope) {
    case "internal":
      return "bg-blue-800 text-blue-50 dark:bg-blue-950 dark:text-blue-100";
    case "web":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200";
    case "public_kb":
    default:
      return "bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-200";
  }
}

export function citationSourceLabel(source: Pick<CitationSource, "sourceKind" | "collection">): string {
  if (isWebCitationSource(source)) return "互联网";
  const name = collectionShortName(source.collection);
  return name || "知识库";
}

export interface TpHermesStreamMeta {
  runId?: string;
  outputId?: string | null;
  validation?: unknown;
  citations?: CitationSource[];
  unresolvedCitationRefs?: number[];
  /** 编排流式阶段：kb_prefetch | agent_generating */
  phase?: string;
  kbPrefetchCount?: number;
  lightweight?: boolean;
  fileActions?: Array<Record<string, unknown>>;
  toolEvents?: AssistantFileToolEvent[];
}

function mapToolEventRow(raw: Record<string, unknown>): AssistantFileToolEvent | null {
  const toolName = raw.tool_name ?? raw.toolName ?? raw.tool;
  if (toolName !== "write_file" && toolName !== "patch") return null;
  const toolCallId = raw.tool_call_id ?? raw.toolCallId;
  const status = raw.status;
  if (typeof toolCallId !== "string" || !toolCallId) return null;
  if (status !== "running" && status !== "completed") return null;
  const path =
    typeof raw.path === "string"
      ? raw.path
      : typeof raw.label === "string" && raw.label.trim()
        ? raw.label.trim()
        : undefined;
  return {
    toolCallId,
    toolName,
    status,
    label: typeof raw.label === "string" ? raw.label : undefined,
    emoji: typeof raw.emoji === "string" ? raw.emoji : undefined,
    path,
  };
}

function mapSourceRow(raw: Record<string, unknown>): CitationSource | null {
  const ref = raw.ref;
  if (typeof ref !== "number") return null;
  const chunkId =
    typeof raw.chunk_id === "string"
      ? raw.chunk_id
      : typeof raw.chunkId === "string"
        ? raw.chunkId
        : "";
  if (!chunkId) return null;
  return {
    ref,
    chunkId,
    docId:
      typeof raw.doc_id === "string"
        ? raw.doc_id
        : typeof raw.docId === "string"
          ? raw.docId
          : undefined,
    title: typeof raw.title === "string" ? raw.title : "",
    collection: typeof raw.collection === "string" ? raw.collection : "",
    excerpt: typeof raw.excerpt === "string" ? raw.excerpt : "",
    chunkIndex: typeof raw.chunk_index === "number" ? raw.chunk_index : undefined,
    chunkCount: typeof raw.chunk_count === "number" ? raw.chunk_count : undefined,
    distance: typeof raw.distance === "number" ? raw.distance : undefined,
    sourceKind:
      raw.source_kind === "web" || raw.sourceKind === "web"
        ? "web"
        : raw.source_kind === "kb" || raw.sourceKind === "kb"
          ? "kb"
          : raw.collection === "互联网"
            ? "web"
            : "kb",
    url:
      typeof raw.url === "string"
        ? raw.url
        : typeof raw.source_url === "string"
          ? raw.source_url
          : undefined,
  };
}

export function mapApiSourcesPayload(raw: unknown): {
  citations: CitationSource[];
  unresolvedCitationRefs: number[];
} {
  if (!raw || typeof raw !== "object") {
    return { citations: [], unresolvedCitationRefs: [] };
  }
  const obj = raw as Record<string, unknown>;
  const rows = Array.isArray(obj.sources) ? obj.sources : [];
  const citations = rows
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    .map(mapSourceRow)
    .filter((s): s is CitationSource => s !== null);
  const unresolved = Array.isArray(obj.unresolved_refs)
    ? obj.unresolved_refs.filter((n): n is number => typeof n === "number")
    : [];
  return { citations, unresolvedCitationRefs: unresolved };
}

/** 解析 SSE data 中的 tphermes_task / tphermes_sources。 */
export function parseTpHermesStreamMeta(data: string): TpHermesStreamMeta | null {
  if (!data || data === "[DONE]") return null;
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    const task = parsed.tphermes_task as Record<string, unknown> | undefined;
    const sourcesRaw = parsed.tphermes_sources;
    const mapped = mapApiSourcesPayload(sourcesRaw);

    const phase = typeof task?.phase === "string" ? task.phase : undefined;
    const hasTaskPayload =
      phase ||
      typeof task?.run_id === "string" ||
      typeof task?.output_id === "string" ||
      task?.validation !== undefined ||
      Array.isArray(task?.file_actions) ||
      Array.isArray(task?.tool_events);
    if (!hasTaskPayload && mapped.citations.length === 0 && mapped.unresolvedCitationRefs.length === 0) {
      return null;
    }

    return {
      runId: typeof task?.run_id === "string" ? task.run_id : undefined,
      outputId: typeof task?.output_id === "string" ? task.output_id : null,
      validation: task?.validation,
      citations: mapped.citations.length > 0 ? mapped.citations : undefined,
      unresolvedCitationRefs:
        mapped.unresolvedCitationRefs.length > 0 ? mapped.unresolvedCitationRefs : undefined,
      phase,
      kbPrefetchCount:
        typeof task?.kb_prefetch_count === "number" ? task.kb_prefetch_count : undefined,
      lightweight: typeof task?.lightweight === "boolean" ? task.lightweight : undefined,
      fileActions: Array.isArray(task?.file_actions)
        ? (task.file_actions as Array<Record<string, unknown>>)
        : undefined,
      toolEvents: Array.isArray(task?.tool_events)
        ? task.tool_events
            .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
            .map(mapToolEventRow)
            .filter((row): row is AssistantFileToolEvent => row !== null)
        : undefined,
    };
  } catch {
    return null;
  }
}

const CITATION_MARKER_RE = /\[\^(\d+)\]/g;
const CITATION_PLACEHOLDER_RE = /\{\{CITE:(\d+)\}\}/g;

export type ContentSegment =
  | { kind: "text"; value: string }
  | { kind: "cite"; ref: number };

/** 将 [^N] 转为占位符，避免 GFM 脚注解析且便于在 Markdown 文本节点内联渲染角标。 */
export function maskCitationMarkers(content: string): string {
  return content.replace(CITATION_MARKER_RE, "{{CITE:$1}}");
}

export function splitTextWithCitationPlaceholders(text: string): ContentSegment[] {
  if (!text.includes("{{CITE:")) {
    return [{ kind: "text", value: text }];
  }
  const segments: ContentSegment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(CITATION_PLACEHOLDER_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({ kind: "text", value: text.slice(lastIndex, index) });
    }
    const ref = Number(match[1]);
    if (Number.isFinite(ref)) {
      segments.push({ kind: "cite", ref });
    }
    lastIndex = index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: "text", value: text.slice(lastIndex) });
  }
  return segments.length > 0 ? segments : [{ kind: "text", value: text }];
}

export function splitContentWithCitations(content: string): ContentSegment[] {
  if (!content.includes("[^")) {
    return [{ kind: "text", value: content }];
  }
  const segments: ContentSegment[] = [];
  let lastIndex = 0;
  for (const match of content.matchAll(CITATION_MARKER_RE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      segments.push({ kind: "text", value: content.slice(lastIndex, index) });
    }
    const ref = Number(match[1]);
    if (Number.isFinite(ref)) {
      segments.push({ kind: "cite", ref });
    }
    lastIndex = index + match[0].length;
  }
  if (lastIndex < content.length) {
    segments.push({ kind: "text", value: content.slice(lastIndex) });
  }
  return segments.length > 0 ? segments : [{ kind: "text", value: content }];
}

export function collectionShortName(collection: string): string {
  const parts = collection.split(".").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : collection;
}

/** 流结束后补拉 run 来源（SSE 未带 citations 或刷新会话时）。 */
export async function fetchRunKbSources(
  runId: string,
): Promise<{ citations: CitationSource[]; unresolvedCitationRefs: number[] }> {
  const { apiGet } = await import("@/lib/api");
  try {
    const data = await apiGet<{ kb_sources?: unknown }>(`/runs/${runId}`);
    return mapApiSourcesPayload(data.kb_sources);
  } catch {
    return { citations: [], unresolvedCitationRefs: [] };
  }
}
