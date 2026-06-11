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

    if (!task && mapped.citations.length === 0 && mapped.unresolvedCitationRefs.length === 0) {
      return null;
    }

    return {
      runId: typeof task?.run_id === "string" ? task.run_id : undefined,
      outputId: typeof task?.output_id === "string" ? task.output_id : null,
      validation: task?.validation,
      citations: mapped.citations.length > 0 ? mapped.citations : undefined,
      unresolvedCitationRefs:
        mapped.unresolvedCitationRefs.length > 0 ? mapped.unresolvedCitationRefs : undefined,
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
