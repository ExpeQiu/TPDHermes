"use client";

import React from "react";

import { ChatMarkdownWithCitations } from "@/components/chat-markdown-with-citations";
import { ChatMessageQuickActions } from "@/components/chat-message-quick-actions";
import type { ContextBlock } from "@/lib/chat-context";

import type { ChatSession, Message } from "@/app/chat/chat-types";

type ChatMessageStreamProps = {
  activeSession?: ChatSession;
  streaming: boolean;
  preparingContext: boolean;
  effectiveKbCollection: string;
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

export function ChatMessageStream({
  activeSession,
  streaming,
  preparingContext,
  effectiveKbCollection,
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
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain space-y-4 px-4 py-4 sm:px-6 md:px-8">
      {(!activeSession || activeSession.messages.length === 0) && (
        <div className="flex min-h-full flex-col items-center justify-center text-slate-500">
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
              {msg.role === "user" ? "我" : msg.role === "system" ? "⚙" : "AI"}
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
                    {msg.content ? (
                      <ChatMarkdownWithCitations
                        content={msg.content}
                        citations={msg.citations}
                        unresolvedCitationRefs={msg.unresolvedCitationRefs}
                        streaming={isStreamingAssistant}
                      />
                    ) : null}
                    {!msg.content && !isStreamingAssistant ? "…" : null}
                    {isStreamingAssistant && msg.content === "" ? (
                      <span className="inline-block h-3.5 w-1.5 animate-pulse bg-blue-400" />
                    ) : null}
                  </>
                )}
              </div>

              {msg.role === "assistant" && msg.content.trim() ? (
                <ChatMessageQuickActions
                  content={msg.content}
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
  );
}
