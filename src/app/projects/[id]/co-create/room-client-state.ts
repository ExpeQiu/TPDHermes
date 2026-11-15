export type RoomFilePurpose = "material" | "target" | "interpret" | "revise";

export type RoomFileRef = {
  project_id: string;
  file_id: string;
  kind: "output" | "attachment";
  version?: string;
  purpose: RoomFilePurpose;
};

export function acceptRoomPayload(
  requestedRoomId: string,
  activeRoomId: string | null,
  epoch: number,
  currentEpoch: number,
): boolean {
  return requestedRoomId === activeRoomId && epoch === currentEpoch;
}

export function seatedRoles<T extends { id: string }>(roles: T[], seatedIds: readonly string[]): T[] {
  const seated = new Set(seatedIds);
  return roles.filter((role) => seated.has(role.id));
}

export type RoomClockMessage = {
  turn_id: string;
  author_type: string;
  turn_state: string;
  created_at?: string | null;
};

/**
 * 带 Z 或偏移的时间按原样解析。
 * 没有时区时，生产容器写的是 UTC；本机进程写的是本地时间。
 * 若按 UTC 读出来比现在超前超过 1 分钟，改按本地时间，避免读秒被夹成 0。
 */
export function parseServerTime(value?: string | null, now = Date.now()): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed);
  if (hasZone) {
    const zoned = Date.parse(trimmed);
    return Number.isFinite(zoned) ? zoned : null;
  }
  const asUtc = Date.parse(`${trimmed}Z`);
  if (!Number.isFinite(asUtc)) return null;
  if (asUtc - now <= 60_000) return asUtc;
  const asLocal = Date.parse(trimmed);
  return Number.isFinite(asLocal) ? asLocal : asUtc;
}

function scanJsonValue(text: string, from: number): { raw: string; end: number } | null {
  let index = from;
  while (index < text.length && /\s/.test(text[index] || "")) index += 1;
  const open = text[index];
  if (open !== "{" && open !== "[") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let cursor = index; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) return { raw: text.slice(index, cursor + 1), end: cursor + 1 };
    }
  }
  return null;
}

function actionDocuments(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { actions?: unknown }).actions)
      ? (value as { actions: unknown[] }).actions
      : [value];
  const documents: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as { action?: unknown; path?: unknown; file?: unknown; content?: unknown };
    const content = typeof record.content === "string" ? record.content.trim() : "";
    const hasAction = typeof record.action === "string" || typeof record.path === "string" || typeof record.file === "string";
    if (!content || !hasAction) continue;
    documents.push(content);
  }
  return documents;
}

/** 把文件动作代码块里的正文展开成 Markdown，不再把整段 JSON 显示成代码。 */
export function expandRoomFileActions(content: string): string {
  const fence = /```(?:TPCharness_file_actions|json)?[^\n]*\n/gi;
  let result = "";
  let cursor = 0;
  for (const match of content.matchAll(fence)) {
    const start = match.index ?? 0;
    if (start < cursor) continue;
    const scanned = scanJsonValue(content, start + match[0].length);
    if (!scanned) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(scanned.raw);
    } catch {
      continue;
    }
    const documents = actionDocuments(parsed);
    if (documents.length === 0) continue;
    let end = scanned.end;
    const closing = /^\s*```/.exec(content.slice(end));
    if (closing) end += closing[0].length;
    result += content.slice(cursor, start) + documents.join("\n\n---\n\n");
    cursor = end;
  }
  return result + content.slice(cursor);
}

export function formatElapsedSeconds(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function questionClock(
  message: RoomClockMessage,
  siblings: readonly RoomClockMessage[],
  now: number,
  knownReply?: RoomClockMessage | null,
): { pending: boolean; status: string; elapsedMs: number | null } {
  const reply =
    knownReply === undefined
      ? siblings.find(
          (item) => item !== message && item.turn_id === message.turn_id && item.author_type === "agent",
        )
      : knownReply;
  const terminal = message.turn_state === "failed" || message.turn_state === "cancelled";
  const answered =
    message.turn_state === "succeeded" || message.turn_state === "done" || Boolean(reply);
  const pending = message.author_type === "human" && !terminal && !answered;
  const status = !pending
    ? terminal
      ? message.turn_state === "cancelled"
        ? "已取消"
        : "失败"
      : answered
        ? "已回答"
        : message.turn_state === "queued"
          ? "排队"
          : "生成中"
    : message.turn_state === "queued"
      ? "排队"
      : "生成中";
  if (message.author_type !== "human") {
    return { pending: false, status: agentStatus(message.turn_state), elapsedMs: null };
  }
  const start = parseServerTime(message.created_at, now);
  if (pending) {
    return { pending: true, status, elapsedMs: start == null ? 0 : Math.max(0, now - start) };
  }
  const end = parseServerTime(reply?.created_at, now);
  return {
    pending: false,
    status,
    elapsedMs: start != null && end != null ? Math.max(0, end - start) : null,
  };
}

function agentStatus(turnState: string): string {
  if (turnState === "failed") return "失败";
  if (turnState === "cancelled") return "已取消";
  if (turnState === "queued") return "排队";
  if (turnState === "running") return "生成中";
  return "完成";
}

export function buildRoomFileRef(
  file: { projectId: string; fileId: string; kind: "output" | "attachment"; version?: string | null },
  purpose: RoomFilePurpose,
): RoomFileRef {
  return {
    project_id: file.projectId,
    file_id: file.fileId,
    kind: file.kind,
    version: file.version || undefined,
    purpose,
  };
}
