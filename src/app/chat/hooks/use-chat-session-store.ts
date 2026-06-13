"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createChatSessionOnServer,
  deleteChatSessionOnServer,
  fetchChatSessionDetail,
  fetchChatSessionsSummary,
  inferSessionKind,
  migrateLocalChatSessions,
  patchChatSessionOnServer,
  syncChatSessionMessagesOnServer,
  upsertChatSessionOnServer,
  type ServerChatSessionSummary,
} from "@/lib/chat-sessions-api";
import type { QuickCreateFlowOverrides } from "@/lib/chat-context";

import type { ChatSession, Message } from "@/app/chat/chat-types";

type UseChatSessionStoreOptions = {
  scopeUserId: string;
  defaultCollection: string;
  onResetTransientState?: () => void;
};

const PLACEHOLDER_SESSION_TITLES = new Set(["新对话", "对话创作"]);

function chatSessionsStorageKey(scopeUserId: string): string {
  return `tphermes-chat-sessions:${scopeUserId}`;
}

function chatActiveStorageKey(scopeUserId: string): string {
  return `tphermes-chat-active:${scopeUserId}`;
}

function loadSessions(scopeUserId: string): ChatSession[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(chatSessionsStorageKey(scopeUserId)) ?? "[]");
  } catch {
    return [];
  }
}

function saveSessions(scopeUserId: string, sessions: ChatSession[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(chatSessionsStorageKey(scopeUserId), JSON.stringify(sessions));
}

function uuid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function firstUserMessageContent(session: ChatSession): string | null {
  const msg = session.messages.find((m) => m.role === "user");
  if (!msg) return null;
  const text = msg.content.trim();
  return text || null;
}

function isPlaceholderSessionTitle(title: string): boolean {
  return PLACEHOLDER_SESSION_TITLES.has(title.trim());
}

function condenseTopicTitle(text: string, maxLen = 16): string {
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

function normalizeSessionsPlaceholders(sessions: ChatSession[]): ChatSession[] {
  return sessions.map((session) => {
    if (!isPlaceholderSessionTitle(session.title)) return session;
    const first = firstUserMessageContent(session);
    if (!first) return session;
    return { ...session, title: condenseTopicTitle(first) };
  });
}

function calcPayloadBytes(payload: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(payload)).length;
  } catch {
    return 0;
  }
}

function sessionToServerPayload(session: ChatSession): Record<string, unknown> {
  return {
    ...session,
    sessionKind: inferSessionKind(session as unknown as Record<string, unknown>),
  };
}

export function sessionToPatchPayload(session: ChatSession): Record<string, unknown> {
  return {
    title: session.title,
    linkedOutputIds: session.linkedOutputIds ?? [],
    linkedRunIds: session.linkedRunIds ?? [],
    scenarioPresetInstructions: session.scenarioPresetInstructions,
    scenarioOpeningHint: session.scenarioOpeningHint,
    taskEntrySummary: session.taskEntrySummary,
    quickCreateOverrides: session.quickCreateOverrides,
    selectedProjectId: session.selectedProjectId ?? "",
    selectedCollection: session.selectedCollection ?? "",
    includeProjectContext: session.includeProjectContext ?? false,
    includeKnowledgeContext: session.includeKnowledgeContext ?? false,
    includeSkillsContext: session.includeSkillsContext ?? false,
    chatMode: session.chatMode ?? "co_create",
    includeFileContext: session.includeFileContext ?? false,
    selectedFileId: session.selectedFileId ?? "",
    rewriteTargetSection: session.rewriteTargetSection,
    rewriteSourceExcerpt: session.rewriteSourceExcerpt,
    rewriteGoal: session.rewriteGoal,
    sessionKind: inferSessionKind(session as unknown as Record<string, unknown>),
  };
}

function messageToSyncPayload(message: Message, sortIndex: number): Record<string, unknown> {
  return {
    ...message,
    sortIndex,
  };
}



function summaryToShellSession(summary: ServerChatSessionSummary): ChatSession {
  return {
    id: summary.id,
    title: summary.title || "新对话",
    messages: [],
    createdAt: summary.createdAt ?? Date.now(),
    linkedOutputIds: [],
    linkedRunIds: [],
    selectedProjectId: "",
    selectedCollection: "",
    includeProjectContext: false,
    includeKnowledgeContext: false,
    includeSkillsContext: false,
    chatMode: "co_create",
    includeFileContext: false,
    selectedFileId: "",
  };
}

async function hydrateSessionDetail(sessionId: string): Promise<ChatSession | null> {
  try {
    const detail = await fetchChatSessionDetail(sessionId);
    return serverSessionToClient(detail);
  } catch (err) {
    console.warn("[chat] 拉取会话详情失败", sessionId, err);
    return null;
  }
}

function serverSessionToClient(raw: Record<string, unknown>): ChatSession {
  const messages = Array.isArray(raw.messages) ? (raw.messages as Message[]) : [];
  return {
    id: String(raw.id || ""),
    title: String(raw.title || "新对话"),
    messages,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
    linkedOutputIds: Array.isArray(raw.linkedOutputIds) ? (raw.linkedOutputIds as string[]) : [],
    linkedRunIds: Array.isArray(raw.linkedRunIds) ? (raw.linkedRunIds as string[]) : [],
    scenarioPresetInstructions:
      typeof raw.scenarioPresetInstructions === "string" ? raw.scenarioPresetInstructions : undefined,
    scenarioOpeningHint: typeof raw.scenarioOpeningHint === "string" ? raw.scenarioOpeningHint : undefined,
    taskEntrySummary: typeof raw.taskEntrySummary === "string" ? raw.taskEntrySummary : undefined,
    quickCreateOverrides:
      raw.quickCreateOverrides && typeof raw.quickCreateOverrides === "object"
        ? (raw.quickCreateOverrides as QuickCreateFlowOverrides)
        : undefined,
    selectedProjectId: typeof raw.selectedProjectId === "string" ? raw.selectedProjectId : "",
    selectedCollection: typeof raw.selectedCollection === "string" ? raw.selectedCollection : "",
    includeProjectContext: Boolean(raw.includeProjectContext),
    includeKnowledgeContext: Boolean(raw.includeKnowledgeContext),
    includeSkillsContext: Boolean(raw.includeSkillsContext),
    chatMode: raw.chatMode === "doc_optimize" ? "doc_optimize" : "co_create",
    includeFileContext: Boolean(raw.includeFileContext),
    selectedFileId: typeof raw.selectedFileId === "string" ? raw.selectedFileId : "",
    rewriteTargetSection:
      typeof raw.rewriteTargetSection === "string" ? raw.rewriteTargetSection : undefined,
    rewriteSourceExcerpt:
      typeof raw.rewriteSourceExcerpt === "string" ? raw.rewriteSourceExcerpt : undefined,
    rewriteGoal: typeof raw.rewriteGoal === "string" ? raw.rewriteGoal : undefined,
  };
}

export function useChatSessionStore({
  scopeUserId,
  defaultCollection,
  onResetTransientState,
}: UseChatSessionStoreOptions) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsSyncError, setSessionsSyncError] = useState("");

  const sessionsRef = useRef<ChatSession[]>([]);
  const activeIdRef = useRef<string | null>(null);
  const sessionPatchTimersRef = useRef<Map<string, number>>(new Map());
  const messageSyncTimersRef = useRef<Map<string, number>>(new Map());
  const pendingSessionPatchRef = useRef<Map<string, Record<string, unknown>>>(new Map());
  const pendingMessageSyncRef = useRef<
    Map<string, { messages: Map<string, Record<string, unknown>>; removedMessageIds: Set<string> }>
  >(new Map());

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeId),
    [activeId, sessions],
  );

  const saveAndSet = useCallback(
    (updated: ChatSession[]) => {
      sessionsRef.current = updated;
      setSessions(updated);
      saveSessions(scopeUserId, updated);
    },
    [scopeUserId],
  );

  const updateSession = useCallback(
    (sessionId: string, updater: (session: ChatSession) => ChatSession) => {
      const next = sessionsRef.current.map((session) =>
        session.id === sessionId ? updater(session) : session,
      );
      saveAndSet(next);
      return next;
    },
    [saveAndSet],
  );

  const queueSessionPatch = useCallback(
    (sessionId: string, payload: Record<string, unknown>, delayMs = 400) => {
      if (!scopeUserId) return;
      pendingSessionPatchRef.current.set(sessionId, {
        ...(pendingSessionPatchRef.current.get(sessionId) ?? {}),
        ...payload,
      });
      const existingTimer = sessionPatchTimersRef.current.get(sessionId);
      if (existingTimer) window.clearTimeout(existingTimer);
      const timer = window.setTimeout(() => {
        sessionPatchTimersRef.current.delete(sessionId);
        const patchPayload = pendingSessionPatchRef.current.get(sessionId);
        pendingSessionPatchRef.current.delete(sessionId);
        if (!patchPayload) return;
        console.info("[chat-metrics] session patch", {
          session_id: sessionId,
          payload_bytes: calcPayloadBytes(patchPayload),
        });
        void patchChatSessionOnServer(sessionId, patchPayload)
          .then(() => setSessionsSyncError(""))
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            setSessionsSyncError(msg);
            console.warn("[chat] 会话 patch 失败", err);
          });
      }, delayMs);
      sessionPatchTimersRef.current.set(sessionId, timer);
    },
    [scopeUserId],
  );

  const queueMessageSync = useCallback(
    (sessionId: string, messages: Message[], removedMessageIds: string[] = [], delayMs = 160) => {
      if (!scopeUserId) return;
      const pending =
        pendingMessageSyncRef.current.get(sessionId) ?? {
          messages: new Map<string, Record<string, unknown>>(),
          removedMessageIds: new Set<string>(),
        };
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      for (const message of messages) {
        const sortIndex = session?.messages.findIndex((item) => item.id === message.id) ?? -1;
        pending.messages.set(
          message.id,
          messageToSyncPayload(message, sortIndex >= 0 ? sortIndex : pending.messages.size),
        );
        pending.removedMessageIds.delete(message.id);
      }
      for (const messageId of removedMessageIds) {
        const trimmed = messageId.trim();
        if (!trimmed) continue;
        pending.messages.delete(trimmed);
        pending.removedMessageIds.add(trimmed);
      }
      pendingMessageSyncRef.current.set(sessionId, pending);
      const existingTimer = messageSyncTimersRef.current.get(sessionId);
      if (existingTimer) window.clearTimeout(existingTimer);
      const timer = window.setTimeout(() => {
        messageSyncTimersRef.current.delete(sessionId);
        const nextPending = pendingMessageSyncRef.current.get(sessionId);
        pendingMessageSyncRef.current.delete(sessionId);
        if (!nextPending) return;
        const payload = {
          messages: Array.from(nextPending.messages.values()),
          removedMessageIds: Array.from(nextPending.removedMessageIds),
        };
        console.info("[chat-metrics] message sync", {
          session_id: sessionId,
          payload_bytes: calcPayloadBytes(payload),
          message_count: payload.messages.length,
          removed_count: payload.removedMessageIds.length,
        });
        void syncChatSessionMessagesOnServer(sessionId, payload)
          .then((result) => {
            setSessionsSyncError("");
            console.info("[chat-metrics] message rewrite", {
              session_id: sessionId,
              created: result.stats.created,
              rewritten: result.stats.rewritten,
              deleted: result.stats.deleted,
            });
          })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            setSessionsSyncError(msg);
            console.warn("[chat] 消息 sync 失败", err);
          });
      }, delayMs);
      messageSyncTimersRef.current.set(sessionId, timer);
    },
    [scopeUserId],
  );

  const flushSessionToServer = useCallback(
    async (sessionId: string, reason: string) => {
      if (!scopeUserId) return;
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      if (!session) return;
      const patchTimer = sessionPatchTimersRef.current.get(sessionId);
      if (patchTimer) {
        window.clearTimeout(patchTimer);
        sessionPatchTimersRef.current.delete(sessionId);
        pendingSessionPatchRef.current.delete(sessionId);
      }
      const messageTimer = messageSyncTimersRef.current.get(sessionId);
      if (messageTimer) {
        window.clearTimeout(messageTimer);
        messageSyncTimersRef.current.delete(sessionId);
        pendingMessageSyncRef.current.delete(sessionId);
      }
      const payload = sessionToServerPayload(session);
      console.info("[chat-metrics] full session flush", {
        session_id: sessionId,
        reason,
        payload_bytes: calcPayloadBytes(payload),
        message_count: session.messages.length,
      });
      await upsertChatSessionOnServer(sessionId, payload);
      setSessionsSyncError("");
    },
    [scopeUserId],
  );

  const createSession = useCallback(
    (defaults?: Partial<ChatSession>) => {
      onResetTransientState?.();
      const session: ChatSession = {
        id: uuid(),
        title: "新对话",
        messages: [],
        createdAt: Date.now(),
        selectedProjectId: defaults?.selectedProjectId ?? "",
        selectedCollection: defaults?.selectedCollection ?? defaultCollection,
        includeProjectContext: defaults?.includeProjectContext ?? false,
        includeKnowledgeContext: defaults?.includeKnowledgeContext ?? false,
        includeSkillsContext: defaults?.includeSkillsContext ?? false,
        chatMode: defaults?.chatMode ?? "co_create",
        includeFileContext: defaults?.includeFileContext ?? false,
        selectedFileId: defaults?.selectedFileId ?? "",
        rewriteTargetSection: defaults?.rewriteTargetSection ?? "",
        rewriteSourceExcerpt: defaults?.rewriteSourceExcerpt ?? "",
        rewriteGoal: defaults?.rewriteGoal ?? "",
      };
      const next = [session, ...sessionsRef.current];
      saveAndSet(next);
      setActiveId(session.id);
      localStorage.setItem(chatActiveStorageKey(scopeUserId), session.id);
      if (scopeUserId) {
        console.info("[chat-metrics] create session", {
          session_id: session.id,
          payload_bytes: calcPayloadBytes(sessionToServerPayload(session)),
        });
        void createChatSessionOnServer(sessionToServerPayload(session)).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          setSessionsSyncError(msg);
          console.warn("[chat] 创建会话失败", err);
        });
      }
      return session;
    },
    [defaultCollection, onResetTransientState, saveAndSet, scopeUserId],
  );

  const selectSession = useCallback(
    (id: string) => {
      setActiveId(id);
      localStorage.setItem(chatActiveStorageKey(scopeUserId), id);
      const existing = sessionsRef.current.find((session) => session.id === id);
      if (existing && existing.messages.length === 0 && scopeUserId) {
        void hydrateSessionDetail(id).then((full) => {
          if (!full) return;
          const next = sessionsRef.current.map((session) =>
            session.id === id ? full : session,
          );
          saveAndSet(next);
        });
      }
    },
    [saveAndSet, scopeUserId],
  );

  const deleteSession = useCallback(
    (id: string) => {
      void deleteChatSessionOnServer(id).catch((err) => {
        console.warn("[chat] 删除服务端会话失败", err);
      });
      const next = sessionsRef.current.filter((session) => session.id !== id);
      if (next.length === 0) {
        createSession();
        return;
      }
      saveAndSet(next);
      if (activeIdRef.current === id) {
        setActiveId(next[0].id);
        localStorage.setItem(chatActiveStorageKey(scopeUserId), next[0].id);
      }
    },
    [createSession, saveAndSet, scopeUserId],
  );

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    return () => {
      for (const timer of sessionPatchTimersRef.current.values()) window.clearTimeout(timer);
      for (const timer of messageSyncTimersRef.current.values()) window.clearTimeout(timer);
      sessionPatchTimersRef.current.clear();
      messageSyncTimersRef.current.clear();
      pendingSessionPatchRef.current.clear();
      pendingMessageSyncRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!scopeUserId) return;
    let cancelled = false;
    setSessionsLoading(true);
    setSessionsSyncError("");

    const bootstrapSessions = async () => {
      const initFromSessions = (saved: ChatSession[]) => {
        const normalized = normalizeSessionsPlaceholders(saved);
        if (normalized.some((session, index) => session.title !== saved[index]?.title)) {
          saveSessions(scopeUserId, normalized);
          console.info("[chat] 已根据首条用户消息回填历史会话主题");
        }
        const active = localStorage.getItem(chatActiveStorageKey(scopeUserId));
        if (normalized.length === 0) {
          const first: ChatSession = {
            id: uuid(),
            title: "新对话",
            messages: [],
            createdAt: Date.now(),
            selectedProjectId: "",
            selectedCollection: "",
            includeProjectContext: false,
            includeKnowledgeContext: false,
            includeSkillsContext: false,
            chatMode: "co_create",
            includeFileContext: false,
            selectedFileId: "",
          };
          saveSessions(scopeUserId, [first]);
          sessionsRef.current = [first];
          setSessions([first]);
          setActiveId(first.id);
          void createChatSessionOnServer(sessionToServerPayload(first)).catch((err) => {
            console.warn("[chat] 创建默认会话失败", err);
          });
        } else {
          sessionsRef.current = normalized;
          setSessions(normalized);
          setActiveId(active && normalized.find((session) => session.id === active) ? active : normalized[0].id);
        }
      };

      try {
        let serverSummaries = await fetchChatSessionsSummary();
        const localRaw = loadSessions(scopeUserId);
        if (serverSummaries.length === 0 && localRaw.length > 0) {
          const migrated = await migrateLocalChatSessions(
            localRaw.map((session) => sessionToServerPayload(session)),
          );
          console.info("[chat] 已将本机会话迁移至服务端", migrated);
          serverSummaries = await fetchChatSessionsSummary();
        }
        if (cancelled) return;
        if (serverSummaries.length > 0) {
          let clientSessions = serverSummaries.map((item) => summaryToShellSession(item));
          const storedActive = localStorage.getItem(chatActiveStorageKey(scopeUserId));
          const targetActive =
            storedActive && clientSessions.some((session) => session.id === storedActive)
              ? storedActive
              : clientSessions[0]?.id;
          if (targetActive) {
            const hydrated = await hydrateSessionDetail(targetActive);
            if (hydrated) {
              clientSessions = clientSessions.map((session) =>
                session.id === targetActive ? hydrated : session,
              );
            }
          }
          if (cancelled) return;
          initFromSessions(clientSessions);
          return;
        }
        initFromSessions(localRaw);
      } catch (err) {
        console.warn("[chat] 拉取服务端会话失败，回退 localStorage", err);
        if (cancelled) return;
        initFromSessions(loadSessions(scopeUserId));
        setSessionsSyncError(err instanceof Error ? err.message : "会话同步失败");
      } finally {
        if (!cancelled) setSessionsLoading(false);
      }
    };

    void bootstrapSessions();
    return () => {
      cancelled = true;
    };
  }, [scopeUserId]);

  return {
    sessions,
    setSessions,
    activeId,
    setActiveId,
    activeSession,
    sessionsLoading,
    sessionsSyncError,
    setSessionsSyncError,
    sessionsRef,
    activeIdRef,
    saveAndSet,
    updateSession,
    queueSessionPatch,
    queueMessageSync,
    flushSessionToServer,
    createSession,
    selectSession,
    deleteSession,
  };
}
