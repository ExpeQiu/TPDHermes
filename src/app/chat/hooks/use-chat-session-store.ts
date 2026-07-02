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
  bulkUpsertChatSessions,
  type ServerChatSessionSummary,
} from "@/lib/chat-sessions-api";
import type { QuickCreateFlowOverrides } from "@/lib/chat-context";

import {
  condenseTopicTitle,
  firstUserMessageContent,
  isPlaceholderSessionTitle,
  isProjectCoCreateSession,
} from "@/lib/chat-session-utils";

import type { ChatSession, Message } from "@/app/chat/chat-types";
import { parseAgentUndoStack } from "@/app/projects/[id]/co-create/co-create-agent-undo";

type UseChatSessionStoreOptions = {
  scopeUserId: string;
  defaultCollection: string;
  storageNamespace?: string;
  onResetTransientState?: () => void;
};

function chatSessionsStorageKey(scopeUserId: string, namespace = "chat"): string {
  return `tphermes-${namespace}-sessions:${scopeUserId}`;
}

function chatActiveStorageKey(scopeUserId: string, namespace = "chat"): string {
  return `tphermes-${namespace}-active:${scopeUserId}`;
}

function loadSessions(scopeUserId: string, namespace = "chat"): ChatSession[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(chatSessionsStorageKey(scopeUserId, namespace)) ?? "[]");
  } catch {
    return [];
  }
}

function saveSessions(scopeUserId: string, sessions: ChatSession[], namespace = "chat") {
  if (typeof window === "undefined") return;
  localStorage.setItem(chatSessionsStorageKey(scopeUserId, namespace), JSON.stringify(sessions));
}

function uuid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
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
    sessionKind:
      session.sessionKind ??
      inferSessionKind(session as unknown as Record<string, unknown>),
  };
}

function filterSessionsForNamespace(
  sessions: ChatSession[],
  namespace: string,
): ChatSession[] {
  if (namespace === "co-create") {
    return sessions.filter((session) => isProjectCoCreateSession(session));
  }
  return sessions.filter((session) => !isProjectCoCreateSession(session));
}

function filterSummariesForNamespace(
  summaries: ServerChatSessionSummary[],
  namespace: string,
): ServerChatSessionSummary[] {
  if (namespace === "co-create") {
    return summaries.filter((summary) => summary.sessionKind === "project_co_create");
  }
  return summaries.filter((summary) => summary.sessionKind !== "project_co_create");
}

function mergeSessionWithLocal(serverSession: ChatSession, localSession?: ChatSession): ChatSession {
  if (!localSession) return serverSession;
  const useLocalMessages = localSession.messages.length > serverSession.messages.length;
  return {
    ...localSession,
    ...serverSession,
    title: serverSession.title || localSession.title,
    messages: useLocalMessages ? localSession.messages : serverSession.messages,
    selectedProjectId: serverSession.selectedProjectId?.trim()
      ? serverSession.selectedProjectId
      : localSession.selectedProjectId,
    pinnedFileIds:
      (serverSession.pinnedFileIds?.length ?? 0) > 0
        ? serverSession.pinnedFileIds
        : localSession.pinnedFileIds,
    roundFileIds:
      (serverSession.roundFileIds?.length ?? 0) > 0
        ? serverSession.roundFileIds
        : localSession.roundFileIds,
    agentUndoStack:
      (serverSession.agentUndoStack?.length ?? 0) > 0
        ? serverSession.agentUndoStack
        : localSession.agentUndoStack,
    touchedFileIds: [
      ...new Set([
        ...(localSession.touchedFileIds ?? []),
        ...(serverSession.touchedFileIds ?? []),
      ]),
    ],
    // 共创 UI 偏好以本地为准，避免 hydrate 覆盖用户刚切换的 Ask/Plan 等模式
    coCreateAgentMode: localSession.coCreateAgentMode ?? serverSession.coCreateAgentMode,
    coCreateApplyMode: localSession.coCreateApplyMode ?? serverSession.coCreateApplyMode,
    coCreatePlanPhase: localSession.coCreatePlanPhase ?? serverSession.coCreatePlanPhase,
    coCreatePipelinePreference:
      localSession.coCreatePipelinePreference ?? serverSession.coCreatePipelinePreference,
  };
}

function mergeLocalSessionsWithServer(
  serverSessions: ChatSession[],
  localSessions: ChatSession[],
): ChatSession[] {
  const localById = new Map(localSessions.map((session) => [session.id, session]));
  const merged = serverSessions.map((session) =>
    mergeSessionWithLocal(session, localById.get(session.id)),
  );
  const serverIds = new Set(serverSessions.map((session) => session.id));
  for (const local of localSessions) {
    if (!serverIds.has(local.id)) merged.push(local);
  }
  return merged;
}

function sessionsNeedingMessageSync(
  merged: ChatSession[],
  serverSessions: ChatSession[],
): ChatSession[] {
  const serverById = new Map(serverSessions.map((session) => [session.id, session]));
  return merged.filter((session) => {
    const server = serverById.get(session.id);
    if (!server) return session.messages.length > 0;
    return session.messages.length > server.messages.length;
  });
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
    sessionKind:
      session.sessionKind ??
      inferSessionKind(session as unknown as Record<string, unknown>),
    pinnedFileIds: session.pinnedFileIds ?? [],
    roundFileIds: session.roundFileIds ?? [],
    archived: session.archived ?? false,
    pendingProposalIds: session.pendingProposalIds ?? [],
    coCreatePipelinePreference: session.coCreatePipelinePreference ?? "auto",
    coCreateAgentMode: session.coCreateAgentMode ?? "agent",
    coCreateApplyMode: session.coCreateApplyMode ?? "auto",
    coCreatePlanPhase: session.coCreatePlanPhase ?? "idle",
    agentUndoStack: session.agentUndoStack ?? [],
    touchedFileIds: session.touchedFileIds ?? [],
    titleManuallySet: session.titleManuallySet ?? false,
  };
}

export { condenseTopicTitle, isPlaceholderSessionTitle };

function messageToSyncPayload(message: Message, sortIndex: number): Record<string, unknown> {
  return {
    ...message,
    sortIndex,
  };
}



function summaryToShellSession(summary: ServerChatSessionSummary): ChatSession {
  const sessionKind = summary.sessionKind;
  return {
    id: summary.id,
    title: summary.title || "新对话",
    messages: [],
    createdAt: summary.createdAt ?? Date.now(),
    linkedOutputIds: [],
    linkedRunIds: [],
    selectedProjectId: "",
    selectedCollection: "",
    includeProjectContext: sessionKind === "project_co_create",
    includeKnowledgeContext: false,
    includeSkillsContext: false,
    chatMode: "co_create",
    includeFileContext: sessionKind === "project_co_create",
    selectedFileId: "",
    sessionKind,
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
    sessionKind: typeof raw.sessionKind === "string" ? raw.sessionKind : undefined,
    pinnedFileIds: Array.isArray(raw.pinnedFileIds) ? (raw.pinnedFileIds as string[]) : [],
    roundFileIds: Array.isArray(raw.roundFileIds) ? (raw.roundFileIds as string[]) : [],
    archived: Boolean(raw.archived),
    pendingProposalIds: Array.isArray(raw.pendingProposalIds)
      ? (raw.pendingProposalIds as string[])
      : [],
    coCreatePipelinePreference:
      raw.coCreatePipelinePreference === "auto" ||
      raw.coCreatePipelinePreference === "fast" ||
      raw.coCreatePipelinePreference === "co_create" ||
      raw.coCreatePipelinePreference === "rewrite" ||
      raw.coCreatePipelinePreference === "research"
        ? raw.coCreatePipelinePreference
        : "auto",
    coCreateAgentMode:
      raw.coCreateAgentMode === "ask" ||
      raw.coCreateAgentMode === "agent" ||
      raw.coCreateAgentMode === "plan"
        ? raw.coCreateAgentMode
        : "agent",
    coCreateApplyMode:
      raw.coCreateApplyMode === "auto" || raw.coCreateApplyMode === "review"
        ? raw.coCreateApplyMode
        : "auto",
    coCreatePlanPhase:
      raw.coCreatePlanPhase === "idle" ||
      raw.coCreatePlanPhase === "awaiting_confirm" ||
      raw.coCreatePlanPhase === "executing"
        ? raw.coCreatePlanPhase
        : "idle",
    agentUndoStack: parseAgentUndoStack(raw.agentUndoStack),
    touchedFileIds: Array.isArray(raw.touchedFileIds) ? (raw.touchedFileIds as string[]) : [],
    titleManuallySet: Boolean(raw.titleManuallySet),
  };
}

export function useChatSessionStore({
  scopeUserId,
  defaultCollection,
  storageNamespace = "chat",
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
      const scoped = filterSessionsForNamespace(updated, storageNamespace);
      sessionsRef.current = scoped;
      setSessions(scoped);
      saveSessions(scopeUserId, scoped, storageNamespace);
      if (activeIdRef.current && !scoped.some((session) => session.id === activeIdRef.current)) {
        const nextActive = scoped[0]?.id ?? null;
        activeIdRef.current = nextActive;
        setActiveId(nextActive);
        if (nextActive) {
          localStorage.setItem(chatActiveStorageKey(scopeUserId, storageNamespace), nextActive);
        }
      }
    },
    [scopeUserId, storageNamespace],
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
        title: defaults?.title ?? "新对话",
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
        sessionKind: defaults?.sessionKind,
        pinnedFileIds: defaults?.pinnedFileIds ?? [],
        roundFileIds: defaults?.roundFileIds ?? [],
        archived: defaults?.archived ?? false,
        pendingProposalIds: defaults?.pendingProposalIds ?? [],
        coCreateAgentMode: defaults?.coCreateAgentMode,
        coCreateApplyMode: defaults?.coCreateApplyMode,
        coCreatePlanPhase: defaults?.coCreatePlanPhase,
        coCreatePipelinePreference: defaults?.coCreatePipelinePreference,
        agentUndoStack: defaults?.agentUndoStack ?? [],
        touchedFileIds: defaults?.touchedFileIds ?? [],
      };
      const next = [session, ...sessionsRef.current];
      saveAndSet(next);
      activeIdRef.current = session.id;
      setActiveId(session.id);
      localStorage.setItem(chatActiveStorageKey(scopeUserId, storageNamespace), session.id);
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
    [defaultCollection, onResetTransientState, saveAndSet, scopeUserId, storageNamespace],
  );

  const selectSession = useCallback(
    (id: string) => {
      activeIdRef.current = id;
      setActiveId(id);
      localStorage.setItem(chatActiveStorageKey(scopeUserId, storageNamespace), id);
      const existing = sessionsRef.current.find((session) => session.id === id);
      if (existing && existing.messages.length === 0 && scopeUserId) {
        void hydrateSessionDetail(id).then((full) => {
          if (!full) return;
          const next = sessionsRef.current.map((session) =>
            session.id === id ? mergeSessionWithLocal(full, session) : session,
          );
          saveAndSet(next);
        });
      }
    },
    [saveAndSet, scopeUserId, storageNamespace],
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
        localStorage.setItem(chatActiveStorageKey(scopeUserId, storageNamespace), next[0].id);
      }
    },
    [createSession, saveAndSet, scopeUserId, storageNamespace],
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
    if (!scopeUserId) {
      setSessionsLoading(false);
      return;
    }
    let cancelled = false;
    setSessionsLoading(true);
    setSessionsSyncError("");

    const bootstrapSessions = async () => {
      const initFromSessions = (saved: ChatSession[]) => {
        const scoped = filterSessionsForNamespace(saved, storageNamespace);
        const normalized = normalizeSessionsPlaceholders(scoped);
        if (normalized.some((session, index) => session.title !== scoped[index]?.title)) {
          saveSessions(scopeUserId, normalized, storageNamespace);
          console.info("[chat] 已根据首条用户消息回填历史会话主题");
        }
        const active = localStorage.getItem(chatActiveStorageKey(scopeUserId, storageNamespace));
        if (normalized.length === 0) {
          const first: ChatSession = {
            id: uuid(),
            title: storageNamespace === "co-create" ? "新共创" : "新对话",
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
            ...(storageNamespace === "co-create"
              ? { sessionKind: "project_co_create" as const }
              : {}),
          };
          saveSessions(scopeUserId, [first], storageNamespace);
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
        saveSessions(scopeUserId, sessionsRef.current, storageNamespace);
      };

      try {
        let serverSummaries = filterSummariesForNamespace(
          await fetchChatSessionsSummary(),
          storageNamespace,
        );
        const localRaw = filterSessionsForNamespace(
          loadSessions(scopeUserId, storageNamespace),
          storageNamespace,
        );
        if (serverSummaries.length === 0 && localRaw.length > 0) {
          const migrated = await migrateLocalChatSessions(
            localRaw.map((session) => sessionToServerPayload(session)),
          );
          console.info("[chat] 已将本机会话迁移至服务端", migrated);
          serverSummaries = filterSummariesForNamespace(
            await fetchChatSessionsSummary(),
            storageNamespace,
          );
        }
        if (cancelled) return;
        if (serverSummaries.length > 0) {
          let clientSessions = serverSummaries.map((item) => summaryToShellSession(item));
          const storedActive = localStorage.getItem(chatActiveStorageKey(scopeUserId, storageNamespace));
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
          const scopedServer = filterSessionsForNamespace(clientSessions, storageNamespace);
          const merged = mergeLocalSessionsWithServer(scopedServer, localRaw);
          const serverById = new Map(scopedServer.map((session) => [session.id, session]));
          const localOnly = merged.filter(
            (session) => !serverById.has(session.id) && session.messages.length >= 0,
          );
          if (localOnly.length > 0) {
            await bulkUpsertChatSessions(localOnly.map((session) => sessionToServerPayload(session)));
          }
          for (const session of sessionsNeedingMessageSync(merged, scopedServer)) {
            console.info("[chat] 本地消息比服务端新，补同步", {
              session_id: session.id,
              message_count: session.messages.length,
            });
            void syncChatSessionMessagesOnServer(session.id, {
              messages: session.messages.map((message, index) => messageToSyncPayload(message, index)),
            }).catch((err) => {
              console.warn("[chat] 补同步消息失败", session.id, err);
            });
          }
          initFromSessions(merged);
          return;
        }
        initFromSessions(localRaw);
      } catch (err) {
        console.warn("[chat] 拉取服务端会话失败，回退 localStorage", err);
        if (cancelled) return;
        initFromSessions(loadSessions(scopeUserId, storageNamespace));
        setSessionsSyncError(err instanceof Error ? err.message : "会话同步失败");
      } finally {
        if (!cancelled) setSessionsLoading(false);
      }
    };

    void bootstrapSessions();
    return () => {
      cancelled = true;
    };
  }, [scopeUserId, storageNamespace]);

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
