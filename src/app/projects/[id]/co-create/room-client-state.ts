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

/** 生产容器写入的时间没有时区，按 UTC 解析。带 Z 或偏移的字符串按原样解析。 */
export function parseServerTime(value?: string | null): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed);
  const parsed = Date.parse(hasZone ? trimmed : `${trimmed}Z`);
  return Number.isFinite(parsed) ? parsed : null;
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
  const start = parseServerTime(message.created_at);
  if (pending) {
    return { pending: true, status, elapsedMs: start == null ? 0 : Math.max(0, now - start) };
  }
  const end = parseServerTime(reply?.created_at);
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
