import type { ChatSession, Message } from "@/app/chat/chat-types";
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

export function userMessageTextForTitle(
  message: Pick<Message, "content" | "userPrompt">,
): string | null {
  const prompt = message.userPrompt?.trim();
  if (prompt) return prompt;
  const text = message.content.trim();
  return text || null;
}

export function firstUserMessageContent(session: ChatSession): string | null {
  const msg = session.messages.find((m) => m.role === "user");
  if (!msg) return null;
  return userMessageTextForTitle(msg);
}

/** 会话已出现用户消息，视为多轮对话进行中 */
export function isChatConversationStarted(
  session: Pick<ChatSession, "messages"> | undefined,
): boolean {
  return Boolean(session?.messages.some((m) => m.role === "user"));
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
    /^请/u,
    /^我想(了解|咨询|问|知道|写|做)?/u,
    /^能否/u,
    /^可以(吗|么)?/u,
    /^关于/u,
    /^请问/u,
    /^基于当前项目上下文[，,:：\s]*/u,
    /^请?基于当前引用的文件[，,:：\s]*/u,
    /^请?基于当前项目[，,:：\s]*/u,
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
    title: "新共创",
    selectedProjectId: projectId,
    includeProjectContext: true,
    includeFileContext: false,
    chatMode: "co_create",
    sessionKind: "project_co_create",
    pinnedFileIds: [],
    roundFileIds: [],
    archived: false,
    pendingProposalIds: [],
    coCreatePipelinePreference: "auto",
    coCreateAgentMode: "agent",
    coCreateApplyMode: "auto",
    coCreatePlanPhase: "idle",
  };
}

/** 项目共创会话（仅 /projects/[id]/co-create 入口，勿用 includeFileContext 推断） */
export function isProjectCoCreateSession(
  session: Pick<ChatSession, "sessionKind">,
): boolean {
  return session.sessionKind === "project_co_create";
}

/** 某项目下未归档的共创会话 */
export function listProjectCoCreateSessions(
  sessions: ChatSession[],
  projectId: string,
): ChatSession[] {
  return sessions.filter(
    (session) =>
      !session.archived &&
      session.selectedProjectId === projectId &&
      isProjectCoCreateSession(session),
  );
}

/**
 * 进入项目共创页时选择应对齐的会话：
 * - 当前 active 已属该项目 → 保持
 * - 否则优先空会话（快捷创作空态），再取最新 createdAt
 */
export function pickProjectCoCreateEntrySession(
  sessions: ChatSession[],
  projectId: string,
  activeSession: ChatSession | null | undefined,
): ChatSession | null {
  const projectSessions = listProjectCoCreateSessions(sessions, projectId);
  if (projectSessions.length === 0) return null;

  if (
    activeSession &&
    activeSession.selectedProjectId === projectId &&
    isProjectCoCreateSession(activeSession)
  ) {
    return activeSession;
  }

  const emptySessions = projectSessions.filter((session) => !isChatConversationStarted(session));
  const pool = emptySessions.length > 0 ? emptySessions : projectSessions;
  return pool.reduce((latest, session) =>
    session.createdAt > latest.createdAt ? session : latest,
  );
}

export function getSessionHistoryCategory(session: ChatSession): SessionHistoryCategory {
  if (isProjectCoCreateSession(session)) return "co_create";
  if (inferSessionKind(session as unknown as Record<string, unknown>) === "scenario") {
    return "scenario";
  }
  return "chat";
}
