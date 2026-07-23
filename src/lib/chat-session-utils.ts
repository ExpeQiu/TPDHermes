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

/**
 * 是否已有落库/可恢复的对话内容。
 * shell（messages=[]）时用 messageCount，避免把有历史的空壳误判为空会话。
 */
export function sessionHasPersistedMessages(
  session: Pick<ChatSession, "messages" | "messageCount"> | undefined,
): boolean {
  if (!session) return false;
  if (isChatConversationStarted(session)) return true;
  return (session.messageCount ?? 0) > 0;
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
  if (session.titleManuallySet) {
    const manual = session.title.trim();
    if (manual) return manual;
  }
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
    touchedFileIds: [],
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

/** 会话是否属于指定项目的共创工作台 */
export function isCoCreateSessionForProject(
  session: Pick<ChatSession, "selectedProjectId" | "sessionKind"> | null | undefined,
  projectId: string,
): boolean {
  return Boolean(
    projectId &&
      session &&
      session.selectedProjectId === projectId &&
      isProjectCoCreateSession(session),
  );
}

/**
 * 进入项目共创页时选择应对齐的会话：
 * - 当前 active 已属该项目 → 保持（含用户刚点的空「新共创」）
 * - 否则优先有历史的会话（含 shell 的 messageCount>0），取最新 createdAt
 * - 仅当本项目全是空会话时，才落最新空壳（快捷创作空态）
 */
export function pickProjectCoCreateEntrySession(
  sessions: ChatSession[],
  projectId: string,
  activeSession: ChatSession | null | undefined,
): ChatSession | null {
  const projectSessions = listProjectCoCreateSessions(sessions, projectId);
  if (projectSessions.length === 0) return null;

  if (isCoCreateSessionForProject(activeSession, projectId) && activeSession) {
    return activeSession;
  }

  const withHistory = projectSessions.filter((session) => sessionHasPersistedMessages(session));
  const pool = withHistory.length > 0 ? withHistory : projectSessions;
  return pool.reduce((latest, session) =>
    session.createdAt > latest.createdAt ? session : latest,
  );
}

/**
 * bootstrap 首屏 hydrate 目标：
 * - 有 preferredProjectId 时，优先该项目下会话（stored active 属该项目则保留，否则按入口挑选）
 * - 否则沿用 storedActive / 列表第一项
 */
export function pickBootstrapHydrateSessionId(
  sessions: Array<
    Pick<
      ChatSession,
      | "id"
      | "createdAt"
      | "archived"
      | "selectedProjectId"
      | "sessionKind"
      | "messages"
      | "messageCount"
    >
  >,
  storedActive: string | null | undefined,
  preferredProjectId?: string,
): string | undefined {
  if (!sessions.length) return undefined;

  if (preferredProjectId?.trim()) {
    const projectSessions = listProjectCoCreateSessions(
      sessions as ChatSession[],
      preferredProjectId.trim(),
    );
    if (projectSessions.length > 0) {
      if (storedActive && projectSessions.some((session) => session.id === storedActive)) {
        return storedActive;
      }
      return pickProjectCoCreateEntrySession(
        sessions as ChatSession[],
        preferredProjectId.trim(),
        null,
      )?.id;
    }
  }

  if (storedActive && sessions.some((session) => session.id === storedActive)) {
    return storedActive;
  }
  return sessions[0]?.id;
}

/**
 * 列出可归档的多余空共创会话 ID（占位标题且无落库消息）。
 * - 项目已有历史：归档旧空壳，但保留 keepSessionId，并额外保留最新一个空壳（避免「+新建」即被清）
 * - 项目仅有空壳：只保留最新一个（或 keepSessionId），归档其余
 * - protectRecentMs：跳过近期新建的空壳，避免点击新建后被立刻归档/冲掉
 */
export function listSurplusEmptyCoCreateSessionIds(
  sessions: ChatSession[],
  projectId: string,
  options?: { keepSessionId?: string | null; protectRecentMs?: number },
): string[] {
  const projectSessions = listProjectCoCreateSessions(sessions, projectId);
  const protectRecentMs = Math.max(0, options?.protectRecentMs ?? 0);
  const now = Date.now();
  const empties = projectSessions.filter((session) => {
    if (sessionHasPersistedMessages(session) || !isPlaceholderSessionTitle(session.title)) {
      return false;
    }
    if (protectRecentMs > 0 && now - (session.createdAt || 0) < protectRecentMs) {
      return false;
    }
    return true;
  });
  if (empties.length === 0) return [];

  const keepSessionId = options?.keepSessionId?.trim() || null;
  const hasHistory = projectSessions.some((session) => sessionHasPersistedMessages(session));
  const newestEmpty = empties.reduce((latest, session) =>
    session.createdAt > latest.createdAt ? session : latest,
  );

  const keepIds = new Set<string>();
  if (keepSessionId && empties.some((session) => session.id === keepSessionId)) {
    keepIds.add(keepSessionId);
  }
  // 有历史时也保留最新空壳，保证「新建」会话不会在同轮/bootstrap 被清掉
  keepIds.add(newestEmpty.id);

  if (!hasHistory && keepIds.size === 0) {
    keepIds.add(newestEmpty.id);
  }

  return empties.filter((session) => !keepIds.has(session.id)).map((session) => session.id);
}

/**
 * 跨项目扫描可归档的多余空共创会话（含无 selectedProjectId 的孤儿空壳）。
 */
export function listAllSurplusEmptyCoCreateSessionIds(
  sessions: ChatSession[],
  options?: { keepSessionId?: string | null; protectRecentMs?: number },
): string[] {
  const projectIds = new Set<string>();
  for (const session of sessions) {
    if (!isProjectCoCreateSession(session) || session.archived) continue;
    const projectId = session.selectedProjectId?.trim();
    if (projectId) projectIds.add(projectId);
  }

  const ids = new Set<string>();
  for (const projectId of projectIds) {
    for (const sessionId of listSurplusEmptyCoCreateSessionIds(sessions, projectId, options)) {
      ids.add(sessionId);
    }
  }

  // 无项目绑定的占位空壳：全部归档（可保留 keepSessionId / 近期保护）
  const keepSessionId = options?.keepSessionId?.trim() || null;
  const protectRecentMs = Math.max(0, options?.protectRecentMs ?? 0);
  const now = Date.now();
  for (const session of sessions) {
    if (!isProjectCoCreateSession(session) || session.archived) continue;
    if (session.selectedProjectId?.trim()) continue;
    if (sessionHasPersistedMessages(session)) continue;
    if (!isPlaceholderSessionTitle(session.title)) continue;
    if (session.id === keepSessionId) continue;
    if (protectRecentMs > 0 && now - (session.createdAt || 0) < protectRecentMs) continue;
    ids.add(session.id);
  }

  return [...ids];
}

export function getSessionHistoryCategory(session: ChatSession): SessionHistoryCategory {
  if (isProjectCoCreateSession(session)) return "co_create";
  if (inferSessionKind(session as unknown as Record<string, unknown>) === "scenario") {
    return "scenario";
  }
  return "chat";
}
