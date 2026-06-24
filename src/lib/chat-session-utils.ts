import type { ChatSession } from "@/app/chat/chat-types";
import { inferSessionKind } from "@/lib/chat-sessions-api";

export type SessionHistoryCategory = "chat" | "scenario" | "co_create";

export const SESSION_HISTORY_TABS: {
  id: SessionHistoryCategory;
  label: string;
}[] = [
  { id: "chat", label: "对话" },
  { id: "scenario", label: "场景" },
  { id: "co_create", label: "输出 / 项目共创" },
];

export const PLACEHOLDER_SESSION_TITLES = new Set(["新对话", "对话创作", "新共创"]);

export function firstUserMessageContent(session: ChatSession): string | null {
  const msg = session.messages.find((m) => m.role === "user");
  if (!msg) return null;
  const text = msg.content.trim();
  return text || null;
}

export function isPlaceholderSessionTitle(title: string): boolean {
  return PLACEHOLDER_SESSION_TITLES.has(title.trim());
}

export function condenseTopicTitle(text: string, maxLen = 16): string {
  let s = text.trim().replace(/\s+/g, " ");
  const firstLine = (s.split(/\n/)[0] ?? s).trim();
  s = firstLine;
  const prefixPatterns = [
    /^请?(帮我|帮忙|协助)?/u,
    /^我想(了解|咨询|问|知道|写|做)?/u,
    /^能否/u,
    /^可以(吗|么)?/u,
    /^关于/u,
    /^请问/u,
  ];
  for (const re of prefixPatterns) {
    const next = s.replace(re, "").trim();
    if (next.length >= 2) s = next;
  }
  s = s.replace(/[？?。！!，,、；;：:.]+$/gu, "").trim();
  if (!s) s = firstLine;
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…`;
}

export function titleFromSession(session: ChatSession | undefined, fallback = "新对话"): string {
  if (!session) return fallback;
  const first = firstUserMessageContent(session);
  if (first) return condenseTopicTitle(first);
  if (isPlaceholderSessionTitle(session.title)) return fallback;
  return session.title;
}

export function projectCoCreateSessionDefaults(projectId: string): Partial<ChatSession> {
  return {
    selectedProjectId: projectId,
    includeProjectContext: true,
    includeFileContext: true,
    chatMode: "co_create",
    sessionKind: "project_co_create",
    pinnedFileIds: [],
    roundFileIds: [],
    archived: false,
    pendingProposalIds: [],
    coCreatePipelinePreference: "auto",
  };
}

/** 项目共创会话 */
export function isProjectCoCreateSession(
  session: Pick<
    ChatSession,
    "sessionKind" | "chatMode" | "includeFileContext" | "selectedProjectId"
  >,
): boolean {
  if (session.sessionKind === "project_co_create") return true;
  return (
    session.chatMode === "co_create" &&
    Boolean(session.includeFileContext) &&
    Boolean(session.selectedProjectId?.trim())
  );
}

export function getSessionHistoryCategory(session: ChatSession): SessionHistoryCategory {
  if (isProjectCoCreateSession(session)) return "co_create";
  if (inferSessionKind(session as unknown as Record<string, unknown>) === "scenario") {
    return "scenario";
  }
  return "chat";
}
