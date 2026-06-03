/** 服务端聊天/场景会话历史 API */
import { apiGet, apiPost, apiPut, apiDelete } from "./api";

export type ChatSessionKind = "chat" | "scenario";

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
  if (session.scenarioPresetInstructions || session.quickCreateOverrides || session.taskEntrySummary) {
    return "scenario";
  }
  return "chat";
}

export function sessionKindLabel(kind: ChatSessionKind | undefined): string {
  return kind === "scenario" ? "场景" : "对话";
}
