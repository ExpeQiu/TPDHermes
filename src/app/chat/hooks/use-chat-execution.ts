"use client";

import { useCallback } from "react";

import { getApiHeaders } from "@/lib/api-headers";
import {
  buildChatTaskContextPayload,
  buildToolsContext,
  formatProjectContextForTaskInput,
  getDocOptimizeBindingStatus,
  orchestrationPreviewToBlocks,
  type ChatMode,
  type ContextBlock,
  type OrchestrationPreviewResponse,
  type ProjectContextResponse,
  type ProjectFileListItem,
  type TaskExecuteBody,
} from "@/lib/chat-context";
import { ensureDerivedUserId, getEffectiveUserIdSync } from "@/lib/user-id";
import { fetchRunKbSources, parseTpHermesStreamMeta } from "@/lib/chat-citations";

import type {
  ChatSession,
  Message,
  OrchestrationPriorTurn,
  RunAssistantStreamParams,
} from "@/app/chat/chat-types";
import { sessionToPatchPayload } from "@/app/chat/hooks/use-chat-session-store";

type FirstTokenMetrics = { count: number; totalMs: number };

type UseChatExecutionOptions = {
  input: string;
  streaming: boolean;
  preparingContext: boolean;
  setStreaming: (value: boolean) => void;
  setPreparingContext: (value: boolean) => void;
  setStreamingPhase: (value: string) => void;
  setError: (value: string) => void;
  setInput: (value: string) => void;
  setSessionsSyncError: (value: string) => void;
  chatMode: ChatMode;
  includeFileContext: boolean;
  includeKnowledgeContext: boolean;
  includeProjectContext: boolean;
  includeSkillsContext: boolean;
  selectedCollection: string;
  selectedFileId: string;
  selectedProjectId: string;
  projectFiles: ProjectFileListItem[];
  projectFilesLoading: boolean;
  projectTaskContext: ProjectContextResponse | null;
  orchestrationPreview: OrchestrationPreviewResponse | null;
  rewriteGoal: string;
  rewriteSourceExcerpt: string;
  rewriteTargetSection: string;
  scenarioFromUrl: string;
  skills: string[];
  showAdvancedOrchestration: boolean;
  useOrchestration: boolean;
  tasksExecuteUrl: string;
  chatApiBase: string;
  chatApiKey: string;
  scopeUserId: string;
  abortRef: React.MutableRefObject<AbortController | null>;
  firstTokenMetricsRef: React.MutableRefObject<FirstTokenMetrics>;
  sessionsRef: React.MutableRefObject<ChatSession[]>;
  activeIdRef: React.MutableRefObject<string | null>;
  updateSession: (sessionId: string, updater: (session: ChatSession) => ChatSession) => ChatSession[];
  queueSessionPatch: (sessionId: string, payload: Record<string, unknown>, delayMs?: number) => void;
  queueMessageSync: (
    sessionId: string,
    messages: Message[],
    removedMessageIds?: string[],
    delayMs?: number,
  ) => void;
  flushSessionToServer: (sessionId: string, reason: string) => Promise<void>;
  isPlaceholderSessionTitle: (title: string) => boolean;
  condenseTopicTitle: (text: string, maxLen?: number) => string;
};

function uuid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function parseSSEDataPayload(data: string): {
  content: string;
  finishReason: string | null;
  errorText: string | null;
} {
  if (data === "[DONE]" || data === "") {
    return { content: "", finishReason: null, errorText: null };
  }
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (parsed.error && typeof parsed.error === "object") {
      const msg = (parsed.error as { message?: string }).message;
      return {
        content: "",
        finishReason: null,
        errorText: typeof msg === "string" ? msg : JSON.stringify(parsed.error),
      };
    }
    const choice = (parsed.choices as Record<string, unknown>[] | undefined)?.[0] as
      | {
          delta?: { content?: unknown };
          message?: { content?: unknown };
          finish_reason?: unknown;
        }
      | undefined;
    let content = "";
    const delta = choice?.delta;
    if (delta && typeof delta === "object") {
      const dc = delta.content;
      if (typeof dc === "string") content += dc;
    } else {
      const mc = choice?.message?.content ?? parsed.content;
      if (typeof mc === "string") content += mc;
    }
    const fr = choice?.finish_reason;
    const finishReason = typeof fr === "string" && fr.length > 0 ? fr : null;
    return { content, finishReason, errorText: null };
  } catch {
    return { content: "", finishReason: null, errorText: null };
  }
}

function accumulateSseTextBlock(block: string): {
  text: string;
  finishReason: string | null;
  errorText: string | null;
} {
  let text = "";
  let finishReason: string | null = null;
  let errorText: string | null = null;
  for (const line of block.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") {
      finishReason = finishReason ?? "stop";
      continue;
    }
    const part = parseSSEDataPayload(data);
    if (part.errorText) errorText = part.errorText;
    text += part.content;
    if (part.finishReason) finishReason = part.finishReason;
  }
  return { text, finishReason, errorText };
}

function applyStreamMetaToAssistantMessage(
  message: Message,
  meta: ReturnType<typeof parseTpHermesStreamMeta>,
): Message {
  if (!meta) return message;
  const next: Message = { ...message };
  if (meta.runId) next.runId = meta.runId;
  if (meta.outputId) next.outputId = meta.outputId;
  if (meta.citations?.length) next.citations = meta.citations;
  if (meta.unresolvedCitationRefs?.length) {
    next.unresolvedCitationRefs = meta.unresolvedCitationRefs;
  }
  return next;
}

const CHAT_CONTINUE_USER =
  "请接着上文直接输出后续内容，不要重复已经给出的段落。若已全部写完则只回复「（已结束）」三字。";
const CHAT_MAX_CONTINUE_ROUNDS = 12;

function messagesToApiPayload(messages: Message[]): { role: string; content: string }[] {
  return messages
    .filter((m) => !(m.role === "assistant" && m.content.trim() === ""))
    .map((message) => ({
      role: message.role,
      content:
        message.role === "user" && message.toolsContext
          ? `${message.toolsContext}\n\n用户问题：${message.content}`
          : message.content,
    }));
}

export function useChatExecution(options: UseChatExecutionOptions) {
  const {
    input,
    streaming,
    preparingContext,
    setStreaming,
    setPreparingContext,
    setStreamingPhase,
    setError,
    setInput,
    setSessionsSyncError,
    chatMode,
    includeFileContext,
    includeKnowledgeContext,
    includeProjectContext,
    includeSkillsContext,
    selectedCollection,
    selectedFileId,
    selectedProjectId,
    projectFiles,
    projectFilesLoading,
    projectTaskContext,
    orchestrationPreview,
    rewriteGoal,
    rewriteSourceExcerpt,
    rewriteTargetSection,
    scenarioFromUrl,
    skills,
    showAdvancedOrchestration,
    useOrchestration,
    tasksExecuteUrl,
    chatApiBase,
    chatApiKey,
    scopeUserId,
    abortRef,
    firstTokenMetricsRef,
    sessionsRef,
    activeIdRef,
    updateSession,
    queueSessionPatch,
    queueMessageSync,
    flushSessionToServer,
    isPlaceholderSessionTitle,
    condenseTopicTitle,
  } = options;

  const runAssistantStream = useCallback(
    async ({
      sessionId,
      text,
      orchestrationPriorMessages,
      priorSession,
    }: RunAssistantStreamParams) => {
      setStreaming(true);
      setStreamingPhase("");
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const assistantId = uuid();
      updateSession(sessionId, (session) => ({
        ...session,
        messages: [...session.messages, { id: assistantId, role: "assistant", content: "" }],
      }));
      const assistantPlaceholder = sessionsRef.current
        .find((session) => session.id === sessionId)
        ?.messages.find((message) => message.id === assistantId);
      if (assistantPlaceholder) {
        queueMessageSync(sessionId, [assistantPlaceholder], [], 0);
      }

      let fullContent = "";
      const streamStartedAt = performance.now();
      let firstTokenCaptured = false;
      const markFirstToken = () => {
        if (firstTokenCaptured) return;
        firstTokenCaptured = true;
        const elapsed = performance.now() - streamStartedAt;
        firstTokenMetricsRef.current = {
          count: firstTokenMetricsRef.current.count + 1,
          totalMs: firstTokenMetricsRef.current.totalMs + elapsed,
        };
        const avg =
          firstTokenMetricsRef.current.totalMs / Math.max(firstTokenMetricsRef.current.count, 1);
        console.info("[chat-metrics] first token", {
          session_id: sessionId,
          first_token_ms: Math.round(elapsed),
          average_first_token_ms: Math.round(avg),
          samples: firstTokenMetricsRef.current.count,
        });
      };

      try {
        let resolvedUserId = scopeUserId || getEffectiveUserIdSync();
        if (!resolvedUserId) {
          try {
            resolvedUserId = await ensureDerivedUserId();
          } catch {
            resolvedUserId = "";
          }
        }
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          ...getApiHeaders(),
        };
        if (resolvedUserId) headers["X-User-ID"] = resolvedUserId;
        if (chatApiKey) headers.Authorization = `Bearer ${chatApiKey}`;

        if (useOrchestration) {
          const qc = priorSession?.quickCreateOverrides;
          const overrides: TaskExecuteBody["overrides"] = {};
          if (showAdvancedOrchestration && includeKnowledgeContext) {
            const cols =
              qc?.knowledgeCollections?.filter(Boolean) ??
              (selectedCollection ? [selectedCollection] : []);
            if (cols.length > 0) overrides.knowledge = { collections: cols };
          }
          if (showAdvancedOrchestration && includeSkillsContext) {
            const list = qc?.skillNames && qc.skillNames.length > 0 ? qc.skillNames : skills;
            const allowed = list.slice(0, 32);
            if (allowed.length > 0) {
              overrides.skills = {
                mode: "allowed_list",
                allowed,
                allow_agent_free_choice: false,
              };
            }
          }
          if (qc?.outputPreset === "structured" && qc.outputRequiredSections?.length) {
            overrides.output = {
              must_follow_template: true,
              required_sections: qc.outputRequiredSections,
            };
          }
          let scenarioPresetInstructions = priorSession?.scenarioPresetInstructions?.trim() ?? "";
          let scenarioOpeningHint = priorSession?.scenarioOpeningHint?.trim() ?? "";
          if (!scenarioPresetInstructions) {
            const sys = priorSession?.messages.find(
              (m) => m.role === "system" && m.content.trim().length > 0,
            );
            if (sys) {
              scenarioPresetInstructions = sys.content
                .replace(/^\s*场景预设[：:]\s*\n?/, "")
                .trim();
            }
          }
          const ctxExtra =
            chatMode !== "doc_optimize" &&
            includeProjectContext &&
            selectedProjectId &&
            projectTaskContext
              ? formatProjectContextForTaskInput(projectTaskContext)
              : "";
          const taskCtx = buildChatTaskContextPayload({
            chatMode,
            includeProjectContext,
            includeFileContext: includeFileContext || chatMode === "doc_optimize",
            selectedProjectId,
            selectedFileValue: selectedFileId,
            projectFiles,
            projectContextExtra: ctxExtra,
            localRewrite: {
              targetSection: rewriteTargetSection,
              sourceExcerpt: rewriteSourceExcerpt,
              rewriteGoal,
            },
          });
          if (taskCtx.error) throw new Error(taskCtx.error);
          const body: TaskExecuteBody = {
            entrypoint: "chat",
            project_id: includeProjectContext && selectedProjectId ? selectedProjectId : null,
            scenario_id: scenarioFromUrl || "general",
            chat_mode: chatMode,
            user_message: text,
            stream: true,
            messages:
              orchestrationPriorMessages.length > 0 ? orchestrationPriorMessages : undefined,
            overrides: Object.keys(overrides).length > 0 ? overrides : undefined,
            user_id: resolvedUserId || undefined,
          };
          if (taskCtx.sourceOutputId) body.source_output_id = taskCtx.sourceOutputId;
          const extraParts: string[] = [];
          if (taskCtx.taskInputExtra.trim()) extraParts.push(taskCtx.taskInputExtra.trim());
          if (
            chatMode !== "doc_optimize" &&
            !taskCtx.sourceOutputId &&
            ctxExtra.trim() &&
            !(includeFileContext && selectedFileId)
          ) {
            extraParts.push(ctxExtra.trim());
          }
          if (extraParts.length > 0) {
            body.task_input = { extra: extraParts.join("\n\n") };
          }
          if (scenarioPresetInstructions) body.scenario_preset_instructions = scenarioPresetInstructions;
          if (scenarioOpeningHint) body.scenario_opening_hint = scenarioOpeningHint;

          const res = await fetch(tasksExecuteUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          if (!res.ok) {
            const errText = await res.text().catch(() => "");
            throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`);
          }
          const reader = res.body?.getReader();
          if (!reader) throw new Error("响应流不可用");
          const decoder = new TextDecoder();
          let buffer = "";

          while (!controller.signal.aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const data = line.slice(6).trim();
              const meta = parseTpHermesStreamMeta(data);
              if (meta?.phase) setStreamingPhase(meta.phase);
              if (meta?.runId || meta?.phase || meta?.citations?.length || meta?.unresolvedCitationRefs?.length) {
                updateSession(sessionId, (session) => ({
                  ...session,
                  linkedOutputIds:
                    meta.outputId != null
                      ? [...new Set([...(session.linkedOutputIds ?? []), meta.outputId])]
                      : session.linkedOutputIds,
                  linkedRunIds: meta.runId
                    ? [...new Set([...(session.linkedRunIds ?? []), meta.runId])]
                    : session.linkedRunIds,
                  messages: session.messages.map((message) =>
                    message.id === assistantId
                      ? applyStreamMetaToAssistantMessage(message, meta)
                      : message,
                  ),
                }));
                const updatedSession = sessionsRef.current.find((session) => session.id === sessionId);
                const updatedAssistant = updatedSession?.messages.find((message) => message.id === assistantId);
                if (updatedSession) queueSessionPatch(sessionId, sessionToPatchPayload(updatedSession), 0);
                if (updatedAssistant) queueMessageSync(sessionId, [updatedAssistant], [], 0);
              }
              const part = parseSSEDataPayload(data);
              if (part.errorText) throw new Error(part.errorText);
              if (part.content) {
                markFirstToken();
                fullContent += part.content;
                updateSession(sessionId, (session) => ({
                  ...session,
                  messages: session.messages.map((message) =>
                    message.id === assistantId ? { ...message, content: fullContent } : message,
                  ),
                }));
                const updatedAssistant = sessionsRef.current
                  .find((session) => session.id === sessionId)
                  ?.messages.find((message) => message.id === assistantId);
                if (updatedAssistant) queueMessageSync(sessionId, [updatedAssistant]);
              }
            }
          }

          if (buffer.trim()) {
            for (const line of buffer.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              const data = line.slice(6).trim();
              const meta = parseTpHermesStreamMeta(data);
              if (meta?.phase) setStreamingPhase(meta.phase);
              if (meta?.runId || meta?.phase || meta?.citations?.length || meta?.unresolvedCitationRefs?.length) {
                updateSession(sessionId, (session) => ({
                  ...session,
                  linkedOutputIds:
                    meta.outputId != null
                      ? [...new Set([...(session.linkedOutputIds ?? []), meta.outputId])]
                      : session.linkedOutputIds,
                  linkedRunIds: meta.runId
                    ? [...new Set([...(session.linkedRunIds ?? []), meta.runId])]
                    : session.linkedRunIds,
                  messages: session.messages.map((message) =>
                    message.id === assistantId
                      ? applyStreamMetaToAssistantMessage(message, meta)
                      : message,
                  ),
                }));
                const updatedSession = sessionsRef.current.find((session) => session.id === sessionId);
                const updatedAssistant = updatedSession?.messages.find((message) => message.id === assistantId);
                if (updatedSession) queueSessionPatch(sessionId, sessionToPatchPayload(updatedSession), 0);
                if (updatedAssistant) queueMessageSync(sessionId, [updatedAssistant], [], 0);
              }
              const part = parseSSEDataPayload(data);
              if (part.errorText) throw new Error(part.errorText);
              if (part.content) {
                markFirstToken();
                fullContent += part.content;
              }
            }
          }

          updateSession(sessionId, (session) => ({
            ...session,
            messages: session.messages.map((message) =>
              message.id === assistantId ? { ...message, content: fullContent || message.content } : message,
            ),
          }));
          const finalizedAssistant = sessionsRef.current
            .find((session) => session.id === sessionId)
            ?.messages.find((message) => message.id === assistantId);
          if (finalizedAssistant) queueMessageSync(sessionId, [finalizedAssistant], [], 0);

          const runIdForSources = sessionsRef.current
            .find((session) => session.id === sessionId)
            ?.messages.find((message) => message.id === assistantId)?.runId;
          if (runIdForSources) {
            const existingCitations = sessionsRef.current
              .find((session) => session.id === sessionId)
              ?.messages.find((message) => message.id === assistantId)?.citations;
            if (!existingCitations?.length) {
              try {
                const fetched = await fetchRunKbSources(runIdForSources);
                if (fetched.citations.length > 0 || fetched.unresolvedCitationRefs.length > 0) {
                  updateSession(sessionId, (session) => ({
                    ...session,
                    messages: session.messages.map((message) =>
                      message.id === assistantId
                        ? {
                            ...message,
                            citations: fetched.citations,
                            unresolvedCitationRefs: fetched.unresolvedCitationRefs,
                          }
                        : message,
                    ),
                  }));
                  const hydratedAssistant = sessionsRef.current
                    .find((session) => session.id === sessionId)
                    ?.messages.find((message) => message.id === assistantId);
                  if (hydratedAssistant) queueMessageSync(sessionId, [hydratedAssistant], [], 0);
                }
              } catch (err) {
                console.warn("[chat] fetchRunKbSources failed", err);
              }
            }
          }
        } else {
          for (let continueRound = 0; continueRound < CHAT_MAX_CONTINUE_ROUNDS; continueRound++) {
            if (controller.signal.aborted) break;
            const sessionSnapshot =
              sessionsRef.current.find((session) => session.id === sessionId)?.messages ?? [];
            const basePayload = messagesToApiPayload(sessionSnapshot);
            const messagesPayload =
              continueRound === 0
                ? basePayload
                : [...basePayload, { role: "user" as const, content: CHAT_CONTINUE_USER }];
            const res = await fetch(chatApiBase, {
              method: "POST",
              headers,
              body: JSON.stringify({
                model: "hermes-agent",
                messages: messagesPayload,
                stream: true,
              }),
              signal: controller.signal,
            });
            if (!res.ok) {
              const errText = await res.text().catch(() => "");
              throw new Error(`HTTP ${res.status}: ${errText || res.statusText}`);
            }
            const reader = res.body?.getReader();
            if (!reader) throw new Error("响应流不可用");
            const decoder = new TextDecoder();
            let buffer = "";
            let roundFinish: string | null = null;

            while (!controller.signal.aborted) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              const { text: chunkText, finishReason, errorText } = accumulateSseTextBlock(
                lines.join("\n"),
              );
              if (errorText) throw new Error(errorText);
              if (finishReason) roundFinish = finishReason;
              if (chunkText) {
                markFirstToken();
                fullContent += chunkText;
                updateSession(sessionId, (session) => ({
                  ...session,
                  messages: session.messages.map((message) =>
                    message.id === assistantId ? { ...message, content: fullContent } : message,
                  ),
                }));
                const updatedAssistant = sessionsRef.current
                  .find((session) => session.id === sessionId)
                  ?.messages.find((message) => message.id === assistantId);
                if (updatedAssistant) queueMessageSync(sessionId, [updatedAssistant]);
              }
            }

            if (buffer.trim()) {
              const { text: chunkText, finishReason, errorText } = accumulateSseTextBlock(buffer);
              if (errorText) throw new Error(errorText);
              if (finishReason) roundFinish = finishReason;
              if (chunkText) {
                markFirstToken();
                fullContent += chunkText;
              }
            }

            updateSession(sessionId, (session) => ({
              ...session,
              messages: session.messages.map((message) =>
                message.id === assistantId ? { ...message, content: fullContent || message.content } : message,
              ),
            }));
            const finalizedAssistant = sessionsRef.current
              .find((session) => session.id === sessionId)
              ?.messages.find((message) => message.id === assistantId);
            if (finalizedAssistant) queueMessageSync(sessionId, [finalizedAssistant], [], 0);
            if (roundFinish !== "length") break;
          }
        }
      } catch (sendError) {
        if ((sendError as Error).name !== "AbortError") {
          setError(`连接失败：${(sendError as Error).message}`);
          updateSession(sessionId, (session) => ({
            ...session,
            messages: session.messages.filter((message) => message.id !== assistantId),
          }));
          queueMessageSync(sessionId, [], [assistantId], 0);
        }
      } finally {
        void flushSessionToServer(sessionId, "stream_complete").catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          setSessionsSyncError(msg);
          console.warn("[chat] 最终落库失败", err);
        });
        setStreaming(false);
        setStreamingPhase("");
      }
    },
    [
      abortRef,
      chatApiBase,
      chatApiKey,
      chatMode,
      flushSessionToServer,
      includeFileContext,
      includeKnowledgeContext,
      includeProjectContext,
      includeSkillsContext,
      projectFiles,
      projectTaskContext,
      queueMessageSync,
      queueSessionPatch,
      rewriteGoal,
      rewriteSourceExcerpt,
      rewriteTargetSection,
      scenarioFromUrl,
      scopeUserId,
      selectedCollection,
      selectedFileId,
      selectedProjectId,
      setError,
      setSessionsSyncError,
      setStreaming,
      setStreamingPhase,
      sessionsRef,
      showAdvancedOrchestration,
      skills,
      tasksExecuteUrl,
      updateSession,
      useOrchestration,
      firstTokenMetricsRef,
    ],
  );

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    const sessionId = activeIdRef.current;
    if (!text || !sessionId || streaming || preparingContext) return;

    if (chatMode === "doc_optimize") {
      const binding = getDocOptimizeBindingStatus({
        selectedProjectId,
        selectedFileValue: selectedFileId,
        projectFiles,
        projectFilesLoading,
      });
      if (!binding.ready) {
        setError(`文稿优化须先完成：${binding.issues.join("、")}`);
        return;
      }
    }

    const ctxPreview = buildChatTaskContextPayload({
      chatMode,
      includeProjectContext,
      includeFileContext: includeFileContext || chatMode === "doc_optimize",
      selectedProjectId,
      selectedFileValue: selectedFileId,
      projectFiles,
      projectContextExtra: "",
      localRewrite: {
        targetSection: rewriteTargetSection,
        sourceExcerpt: rewriteSourceExcerpt,
        rewriteGoal,
      },
    });
    if (ctxPreview.error) {
      setError(ctxPreview.error);
      return;
    }

    setError("");
    setPreparingContext(true);

    const priorSession = sessionsRef.current.find((session) => session.id === sessionId);
    const priorMessages: OrchestrationPriorTurn[] = [];
    for (const message of priorSession?.messages ?? []) {
      if (message.role === "user" || message.role === "assistant") {
        priorMessages.push({ role: message.role, content: message.content });
      }
    }

    let contextWarnings: string[] = [];
    let contextBlocks: ContextBlock[] = [];
    let toolsContext = "";

    try {
      if (useOrchestration) {
        if (orchestrationPreview) contextBlocks = orchestrationPreviewToBlocks(orchestrationPreview);
      } else if (
        (includeProjectContext && selectedProjectId) ||
        (includeKnowledgeContext && selectedCollection) ||
        includeSkillsContext
      ) {
        const qc = priorSession?.quickCreateOverrides;
        const skillsForContext = (() => {
          if (!includeSkillsContext) return [] as string[];
          if (qc?.skillNames && qc.skillNames.length > 0) return qc.skillNames.slice(0, 32);
          return skills.slice(0, 32);
        })();
        const built = await buildToolsContext({
          query: text,
          projectId: selectedProjectId || undefined,
          collectionName: selectedCollection || undefined,
          includeProject: includeProjectContext,
          includeKnowledge: includeKnowledgeContext,
          includeSkills: skillsForContext.length > 0,
          skillSnapshot: skillsForContext,
        });
        toolsContext = built.toolsContext;
        contextBlocks = built.blocks;
        contextWarnings = built.warnings;
      }
    } finally {
      setPreparingContext(false);
    }

    const userMsg: Message = {
      id: uuid(),
      role: "user",
      content: text,
      toolsContext,
      contextBlocks,
      contextWarnings,
    };

    updateSession(sessionId, (session) => {
      const messages = [...session.messages, userMsg];
      const isFirstUser = !session.messages.some((message) => message.role === "user");
      const next: ChatSession = { ...session, messages };
      if (isFirstUser && isPlaceholderSessionTitle(session.title)) {
        next.title = condenseTopicTitle(text);
      }
      return next;
    });
    const updatedSession = sessionsRef.current.find((session) => session.id === sessionId);
    if (updatedSession) {
      queueMessageSync(sessionId, [userMsg], [], 0);
      queueSessionPatch(sessionId, sessionToPatchPayload(updatedSession), 0);
    }
    setInput("");

    const sessionAfterUser = sessionsRef.current.find((session) => session.id === sessionId);
    if (!sessionAfterUser) return;

    await runAssistantStream({
      sessionId,
      text,
      orchestrationPriorMessages: priorMessages,
      priorSession: sessionAfterUser,
    });
  }, [
    activeIdRef,
    chatMode,
    condenseTopicTitle,
    includeFileContext,
    includeKnowledgeContext,
    includeProjectContext,
    includeSkillsContext,
    input,
    isPlaceholderSessionTitle,
    orchestrationPreview,
    preparingContext,
    projectFiles,
    projectFilesLoading,
    queueMessageSync,
    queueSessionPatch,
    rewriteGoal,
    rewriteSourceExcerpt,
    rewriteTargetSection,
    runAssistantStream,
    selectedCollection,
    selectedFileId,
    selectedProjectId,
    setError,
    setInput,
    setPreparingContext,
    skills,
    streaming,
    updateSession,
    useOrchestration,
    sessionsRef,
  ]);

  const regenerateAssistantReply = useCallback(
    async (assistantMessageId: string) => {
      const sessionId = activeIdRef.current;
      if (!sessionId || streaming || preparingContext) return;
      if (abortRef.current) abortRef.current.abort();
      const session = sessionsRef.current.find((item) => item.id === sessionId);
      if (!session) return;

      const assistantIdx = session.messages.findIndex((message) => message.id === assistantMessageId);
      if (assistantIdx < 0 || session.messages[assistantIdx]?.role !== "assistant") return;

      let userIdx = -1;
      for (let i = assistantIdx - 1; i >= 0; i--) {
        if (session.messages[i]?.role === "user") {
          userIdx = i;
          break;
        }
      }
      if (userIdx < 0) {
        setError("找不到对应的用户问题，无法再次生成");
        return;
      }

      const userMsg = session.messages[userIdx];
      const userText = userMsg.content.trim();
      if (!userText) {
        setError("用户问题为空，无法再次生成");
        return;
      }

      const truncatedMessages = session.messages.slice(0, assistantIdx);
      const orchestrationPrior: OrchestrationPriorTurn[] = [];
      for (let i = 0; i < userIdx; i++) {
        const message = truncatedMessages[i];
        if (message.role === "user" || message.role === "assistant") {
          orchestrationPrior.push({ role: message.role, content: message.content });
        }
      }

      setError("");
      updateSession(sessionId, (current) => ({ ...current, messages: truncatedMessages }));
      const removedIds = session.messages.slice(assistantIdx).map((message) => message.id);
      queueMessageSync(sessionId, [], removedIds, 0);
      const updatedSession = sessionsRef.current.find((item) => item.id === sessionId);
      if (updatedSession) queueSessionPatch(sessionId, sessionToPatchPayload(updatedSession), 0);

      const priorSession: ChatSession = { ...session, messages: truncatedMessages };
      await runAssistantStream({
        sessionId,
        text: userText,
        orchestrationPriorMessages: orchestrationPrior,
        priorSession,
      });
    },
    [
      abortRef,
      activeIdRef,
      preparingContext,
      queueMessageSync,
      queueSessionPatch,
      runAssistantStream,
      setError,
      sessionsRef,
      streaming,
      updateSession,
    ],
  );

  return {
    sendMessage,
    regenerateAssistantReply,
  };
}
