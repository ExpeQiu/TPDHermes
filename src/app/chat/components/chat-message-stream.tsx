"use client";

import React, { useEffect, useState } from "react";

import { ChatMarkdownWithCitations } from "@/components/chat-markdown-with-citations";
import { ChatMessageQuickActions } from "@/components/chat-message-quick-actions";
import { stripFileActionsBlock } from "@/app/projects/[id]/co-create/co-create-file-actions";
import type { ContextBlock } from "@/lib/chat-context";
import { StreamingWaitHint } from "@/components/streaming-wait-hint";
import {
  buildStreamingWaitHint,
  isFirstAssistantTurn,
} from "@/lib/streaming-wait-hint";
import type { ChatSession, Message } from "@/app/chat/chat-types";
import { formatMessageTimestamp } from "@/lib/datetime";
import {
  formatTurnDuration,
  shortConversationId,
  turnStartedAtMs,
} from "@/lib/turn-duration";

type ChatMessageStreamProps = {
  activeSession?: ChatSession;
  streaming: boolean;
  preparingContext: boolean;
  streamingPhase?: string;
  effectiveKbCollection: string;
  includeProjectContext: boolean;
  selectedProjectId: string;
  projectFromUrl: string;
  activeId: string | null;
  scenarioFromUrl: string;
  selectedSourceOutputId: string | null;
  onRegenerate: (assistantMessageId: string) => Promise<void>;
  titleFromSession: (session: ChatSession | undefined) => string;
  error: string;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
};

function truncate(text: string, max = 180) {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function visibleContextBlocks(message: Message): ContextBlock[] {
  return message.contextBlocks?.filter((block) => block.tool !== "orchestration_preview") ?? [];
}

function isFirstAssistantTurnForSession(session: ChatSession, message: Message): boolean {
  if (message.role !== "assistant") return false;
  return isFirstAssistantTurn(session.messages);
}

function TurnStatusLine({
  startedAt,
  elapsedMs,
  inProgress,
  outcome,
  conversationId,
  messageId,
}: {
  startedAt: number;
  elapsedMs?: number;
  inProgress: boolean;
  outcome?: Message["turnOutcome"];
  conversationId: string;
  messageId: string;
}) {
  const [liveSeconds, setLiveSeconds] = useState(() =>
    Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
  );

  useEffect(() => {
    if (!inProgress) return;
    const origin = Number.isFinite(startedAt) ? startedAt : Date.now();
    const tick = () => setLiveSeconds(Math.max(0, Math.floor((Date.now() - origin) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    console.info("[chat] wait elapsed start", { message_id: messageId, started_at: origin });
    return () => {
      window.clearInterval(timer);
      console.info("[chat] wait elapsed stop", {
        message_id: messageId,
        started_at: origin,
        elapsed_sec: Math.max(0, Math.floor((Date.now() - origin) / 1000)),
      });
    };
  }, [inProgress, messageId, startedAt]);

  const seconds = inProgress
    ? liveSeconds
    : Math.max(0, Math.round((elapsedMs ?? 0) / 1000));
  const label = inProgress ? "进行中" : outcome === "interrupted" ? "已中断" : "已结束";
  const duration = formatTurnDuration(seconds);

  return (
    <span className="inline-flex items-center gap-3 tabular-nums" role="status" aria-live="polite">
      <span>
        {label} · {duration}
      </span>
      {conversationId ? <span>对话 {conversationId}</span> : null}
    </span>
  );
}

export function ChatMessageStream({
  activeSession,
  streaming,
  preparingContext,
  streamingPhase,
  effectiveKbCollection,
  includeProjectContext,
  selectedProjectId,
  projectFromUrl,
  activeId,
  scenarioFromUrl,
  selectedSourceOutputId,
  onRegenerate,
  titleFromSession,
  error,
  messagesEndRef,
}: ChatMessageStreamProps) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div className="flex min-h-full flex-col space-y-4 px-4 py-4 sm:px-6 md:px-8">
      {(!activeSession || activeSession.messages.length === 0) && (
        <div className="flex flex-1 flex-col items-center justify-center text-slate-500">
          <p className="text-4xl mb-4">💬</p>
          <p className="text-sm">开始一段新对话吧</p>
          <p className="text-xs mt-1 text-slate-600">回车发送 · Shift+回车换行</p>
        </div>
      )}

      {activeSession?.messages.map((msg) => {
        const contextBlocks = visibleContextBlocks(msg);
        const isStreamingAssistant =
          streaming &&
          msg.role === "assistant" &&
          msg.id === activeSession.messages[activeSession.messages.length - 1]?.id;
        const displayContent =
          msg.role === "assistant" ? stripFileActionsBlock(msg.content) : msg.content;
        const messageTime = formatMessageTimestamp(msg.createdAt);
        const isTurnInProgress =
          streaming &&
          msg.role === "assistant" &&
          msg.id === activeSession.messages[activeSession.messages.length - 1]?.id;
        const showTurnStatus =
          msg.role === "assistant" && (isTurnInProgress || typeof msg.elapsedMs === "number");
        const elapsedStartedAt = showTurnStatus
          ? (turnStartedAtMs(activeSession.messages, msg.id) ?? msg.createdAt ?? Date.now())
          : null;
        const conversationId = shortConversationId(activeSession.id);

        return (
          <div
            key={msg.id}
            className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : ""}`}
          >
            <div
              className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                msg.role === "user"
                  ? "bg-blue-600"
                  : msg.role === "system"
                    ? "bg-orange-600"
                    : "bg-slate-600"
              }`}
            >
              {msg.role === "user" ? "我" : msg.role === "system" ? "⚙" : "TA"}
            </div>

            <div className="max-w-[78%]">
              {contextBlocks.length > 0 && (
                <div className="mb-2 rounded-xl border border-slate-300 bg-white/90 px-3 py-3 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300">
                  <div className="font-medium text-slate-800 dark:text-slate-200 mb-2">
                    {`已注入 ${contextBlocks.length} 项显式上下文`}
                  </div>
                  <div className="space-y-2">
                    {contextBlocks.map((block) => (
                      <div
                        key={`${msg.id}-${block.tool}`}
                        className="rounded-lg bg-slate-200/70 p-2 dark:bg-slate-800/70"
                      >
                        <div className="text-blue-300">{block.tool}</div>
                        <div className="text-slate-800 dark:text-slate-200 mt-1">{block.title}</div>
                        <pre className="whitespace-pre-wrap text-slate-400 mt-1 font-sans">
                          {truncate(block.content, 260)}
                        </pre>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {msg.contextWarnings && msg.contextWarnings.length > 0 && (
                <div className="mb-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700/40 dark:bg-amber-950/20 dark:text-amber-300">
                  {msg.contextWarnings.join("；")}
                </div>
              )}

              <div
                className={`rounded-2xl px-4 py-2.5 min-w-0 ${
                  msg.role === "user"
                    ? "whitespace-pre-wrap text-sm leading-relaxed bg-blue-600 text-white rounded-tr-sm"
                    : msg.role === "system"
                      ? "rounded-tl-sm border border-orange-300 bg-orange-50 text-orange-900 dark:border-orange-700/30 dark:bg-orange-900/50 dark:text-orange-100"
                      : "bg-slate-300 dark:bg-slate-700 text-slate-800 dark:text-slate-200 rounded-tl-sm"
                }`}
              >
                {msg.role === "user" ? (
                  msg.content || "…"
                ) : (
                  <>
                    {displayContent ? (
                      <ChatMarkdownWithCitations
                        content={displayContent}
                        citations={msg.citations}
                        unresolvedCitationRefs={msg.unresolvedCitationRefs}
                        streaming={isStreamingAssistant}
                      />
                    ) : null}
                    {!displayContent && !isStreamingAssistant ? "…" : null}
                    {isStreamingAssistant && !displayContent.trim() ? (
                      <StreamingWaitHint
                        text={buildStreamingWaitHint({
                          isFirstTurn: isFirstAssistantTurnForSession(activeSession, msg),
                          includeProject: includeProjectContext,
                          phase: streamingPhase,
                        })}
                      />
                    ) : null}
                  </>
                )}
              </div>

              {messageTime || elapsedStartedAt != null ? (
                <div
                  className={`mt-1 flex items-center gap-2 text-[11px] leading-none text-slate-400 dark:text-slate-500 ${
                    msg.role === "user" ? "justify-end text-right" : "justify-start text-left"
                  }`}
                >
                  {messageTime ? <span>{messageTime}</span> : null}
                  {elapsedStartedAt != null ? (
                    <TurnStatusLine
                      startedAt={elapsedStartedAt}
                      elapsedMs={msg.elapsedMs}
                      inProgress={isTurnInProgress}
                      outcome={msg.turnOutcome}
                      conversationId={conversationId}
                      messageId={msg.id}
                    />
                  ) : null}
                </div>
              ) : null}

              {msg.role === "assistant" && displayContent.trim() ? (
                <ChatMessageQuickActions
                  content={displayContent}
                  role={msg.role}
                  messageId={msg.id}
                  exportTitle={titleFromSession(activeSession)}
                  collectionName={effectiveKbCollection}
                  projectId={selectedProjectId || projectFromUrl}
                  sessionId={activeId}
                  runId={msg.runId}
                  outputId={msg.outputId}
                  scenarioId={scenarioFromUrl || "general"}
                  sourceOutputId={selectedSourceOutputId}
                  onRegenerate={onRegenerate}
                  actionsDisabled={streaming || preparingContext}
                  initialFeedbackLevel={msg.feedbackLevel}
                />
              ) : null}
            </div>
          </div>
        );
      })}

      {error && (
        <div className="flex gap-3">
          <div className="flex-shrink-0 w-8 h-8 rounded-full bg-red-600 flex items-center justify-center text-sm font-medium">
            !
          </div>
          <div className="max-w-[75%] rounded-2xl rounded-tl-sm border border-red-300 bg-red-50 px-4 py-2.5 text-sm text-red-800 dark:border-red-700/50 dark:bg-red-900/40 dark:text-red-300">
            ❌ {error}
          </div>
        </div>
      )}

      <div ref={messagesEndRef} />
      </div>
    </div>
  );
}
