/** 服务端聊天/场景会话历史 API */
import { apiGet, apiPost, apiPut, apiDelete, apiPatch } from "./api";

export type ChatSessionKind = "chat" | "scenario" | "project_co_create";

export interface ServerChatSessionSummary {
  id: string;
  title: string;
  sessionKind?: ChatSessionKind;
  createdAt?: number;
  updatedAt?: string;
  messageCount?: number;
}

export interface ServerChatSession extends Record<string, unknown> {
  id: string;
  title: string;
  messages: Array<Record<string, unknown>>;
  createdAt?: number;
  linkedOutputIds?: string[];
  linkedRunIds?: string[];
  sessionKind?: ChatSessionKind;
}

export async function fetchChatSessionsSummary(): Promise<ServerChatSessionSummary[]> {
  const data = await apiGet<{ items: ServerChatSessionSummary[] }>("/chat/sessions");
  return data.items ?? [];
}

export async function fetchChatSessionDetail(sessionId: string): Promise<ServerChatSession> {
  return apiGet<ServerChatSession>(`/chat/sessions/${encodeURIComponent(sessionId)}`);
}

export async function fetchChatSessionsFull(): Promise<ServerChatSession[]> {
  const data = await apiGet<{ items: ServerChatSession[] }>("/chat/sessions?full=1");
  return data.items ?? [];
}

export async function createChatSessionOnServer(
  payload: Record<string, unknown>,
): Promise<ServerChatSession> {
  return apiPost<ServerChatSession>("/chat/sessions", payload);
}

export async function upsertChatSessionOnServer(
  sessionId: string,
  payload: Record<string, unknown>,
): Promise<ServerChatSession> {
  return apiPut<ServerChatSession>(`/chat/sessions/${encodeURIComponent(sessionId)}`, payload);
}

export async function patchChatSessionOnServer(
  sessionId: string,
  payload: Record<string, unknown>,
): Promise<ServerChatSession> {
  return apiPatch<ServerChatSession>(`/chat/sessions/${encodeURIComponent(sessionId)}`, payload);
}

export async function syncChatSessionMessagesOnServer(
  sessionId: string,
  payload: {
    messages: Record<string, unknown>[];
    removedMessageIds?: string[];
  },
): Promise<{
  session: ServerChatSession;
  stats: { created: number; rewritten: number; deleted: number };
}> {
  return apiPost(`/chat/sessions/${encodeURIComponent(sessionId)}/messages/sync`, payload);
}

export async function deleteChatSessionOnServer(sessionId: string): Promise<void> {
  await apiDelete(`/chat/sessions/${encodeURIComponent(sessionId)}`);
}

export async function migrateLocalChatSessions(
  sessions: Record<string, unknown>[],
): Promise<{ imported: number; skipped: number }> {
  const data = await apiPost<{ imported: number; skipped: number }>(
    "/chat/sessions/migrate-local",
    { sessions },
  );
  return { imported: data.imported ?? 0, skipped: data.skipped ?? 0 };
}

export async function bulkUpsertChatSessions(
  sessions: Record<string, unknown>[],
): Promise<void> {
  await apiPost("/chat/sessions/bulk-upsert", { sessions });
}

export function inferSessionKind(session: Record<string, unknown>): ChatSessionKind {
  const explicit = session.sessionKind;
  if (explicit === "project_co_create") return "project_co_create";
  if (
    session.chatMode === "co_create" &&
    session.includeFileContext &&
    typeof session.selectedProjectId === "string" &&
    session.selectedProjectId.trim()
  ) {
    return "project_co_create";
  }
  if (session.scenarioPresetInstructions || session.quickCreateOverrides || session.taskEntrySummary) {
    return "scenario";
  }
  return "chat";
}

export function sessionKindLabel(kind: ChatSessionKind | undefined): string {
  if (kind === "scenario") return "场景";
  if (kind === "project_co_create") return "共创";
  return "对话";
}
