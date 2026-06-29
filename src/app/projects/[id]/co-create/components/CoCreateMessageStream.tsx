"use client";

import Link from "next/link";
import { ChatMarkdownWithCitations } from "@/components/chat-markdown-with-citations";
import { StreamingWaitHint } from "@/components/streaming-wait-hint";
import {
  buildStreamingWaitHint,
  isFirstAssistantTurn,
} from "@/lib/streaming-wait-hint";
import type { AssistantToolEvent, Message, MessageRegionExcerpt } from "@/app/chat/chat-types";
import type { FileActionProposal } from "@/app/projects/[id]/co-create/co-create-types";
import {
  parseAgentPlanFromContent,
  stripAgentPlanBlock,
} from "@/app/projects/[id]/co-create/co-create-agent-utils";
import { stripFileActionsBlock } from "@/app/projects/[id]/co-create/co-create-file-actions";
import { unwrapSkillAssistantMarkdown } from "@/lib/skill-output";
import { AgentActivityTimeline } from "@/app/projects/[id]/co-create/components/AgentActivityTimeline";
import { AgentPlanCard } from "@/app/projects/[id]/co-create/components/AgentPlanCard";
import type { CoCreateQuickEntry } from "@/lib/co-create-quick-entries";
import type { ReactNode } from "react";

type Props = {
  messages: Message[];
  streaming?: boolean;
  streamingPhase?: string;
  renderAfterMessage?: (message: Message) => ReactNode;
  quickEntries?: CoCreateQuickEntry[];
  quickEntriesLoading?: boolean;
  moreHref?: string;
  onQuickStart?: (entry: CoCreateQuickEntry) => void;
  quickStartDisabled?: boolean;
};

export function CoCreateMessageStream({
  messages,
  streaming,
  streamingPhase,
  renderAfterMessage,
  quickEntries = [],
  quickEntriesLoading,
  moreHref = "/create",
  onQuickStart,
  quickStartDisabled,
}: Props) {
  if (messages.length === 0 && !streaming) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 p-5 dark:border-slate-700 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">快捷创作入口</p>
          <Link
            href={moreHref}
            className="shrink-0 rounded-md border border-slate-300 px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-600 transition hover:border-slate-400 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:bg-slate-800"
          >
            more
          </Link>
        </div>
        {quickEntriesLoading ? (
          <p className="mt-4 text-sm text-slate-500">加载场景列表…</p>
        ) : quickEntries.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">
            暂无可用场景，请前往
            <Link href={moreHref} className="mx-1 text-blue-600 hover:underline dark:text-blue-400">
              场景编排
            </Link>
            配置并发布。
          </p>
        ) : (
          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {quickEntries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                disabled={quickStartDisabled || !onQuickStart}
                onClick={() => onQuickStart?.(entry)}
                className="group flex h-full flex-col rounded-2xl border border-slate-300 bg-white p-4 text-left transition hover:-translate-y-0.5 hover:border-slate-400 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:hover:border-slate-600 dark:hover:bg-slate-800/80"
              >
                <div className="flex h-5 shrink-0 items-end">
                  <div
                    className={`h-1 w-8 rounded-full bg-gradient-to-r ${entry.accent}`}
                    aria-hidden
                  />
                </div>
                <p className="mt-3 min-h-[2.75rem] text-sm font-medium leading-snug text-slate-800 dark:text-slate-100">
                  {entry.title}
                </p>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {messages
        .filter((m) => m.role !== "system")
        .map((message, index, visibleMessages) => {
          const isStreamingAssistant =
            Boolean(streaming) &&
            message.role === "assistant" &&
            index === visibleMessages.length - 1 &&
            !message.content.trim();
          const actionSummary =
            message.role === "assistant"
              ? summarizeFileExecution(message.fileActions, message.toolEvents)
              : null;
          const agentPlan =
            message.agentPlan ??
            (message.role === "assistant" ? parseAgentPlanFromContent(message.content) : null);
          const displayContent = (() => {
            if (message.role !== "assistant") return message.content;
            let text = unwrapSkillAssistantMarkdown(message.content);
            if (parseAgentPlanFromContent(text)) {
              text = stripAgentPlanBlock(text);
            }
            return stripFileActionsBlock(text);
          })();

          return (
            <div
              key={message.id}
              className={`rounded-2xl px-4 py-3 ${
                message.role === "user"
                  ? "ml-8 bg-blue-600 text-white"
                  : "mr-8 border border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-800"
              }`}
            >
              {message.role === "user" ? (
                <UserMessageBubble message={message} />
              ) : (
                <>
                  {isStreamingAssistant ? (
                    <AgentActivityTimeline
                      phase={streamingPhase}
                      toolEvents={message.toolEvents}
                      streaming
                    />
                  ) : message.toolEvents?.length ? (
                    <AgentActivityTimeline toolEvents={message.toolEvents} />
                  ) : null}
                  {agentPlan && !isStreamingAssistant ? <AgentPlanCard plan={agentPlan} /> : null}
                  {actionSummary && !isStreamingAssistant ? (
                    <AgentExecutionPanel summary={actionSummary} />
                  ) : null}
                  {displayContent ? (
                    <ChatMarkdownWithCitations
                      content={displayContent}
                      citations={message.citations}
                      unresolvedCitationRefs={message.unresolvedCitationRefs}
                      streaming={isStreamingAssistant}
                    />
                  ) : actionSummary ? (
                    <p className="mt-3 whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-300">
                      {actionSummary.fallbackText}
                    </p>
                  ) : null}
                  {isStreamingAssistant && !displayContent?.trim() ? (
                    <StreamingWaitHint
                      text={buildStreamingWaitHint({
                        isFirstTurn: isFirstAssistantTurn(messages),
                        includeProject: !streamingPhase?.startsWith("co_create"),
                        phase: streamingPhase,
                      })}
                    />
                  ) : null}
                  {!isStreamingAssistant &&
                  message.role === "assistant" &&
                  !displayContent?.trim() &&
                  !actionSummary &&
                  !agentPlan &&
                  !(message.toolEvents?.length) ? (
                    <p className="text-sm leading-relaxed text-slate-500 dark:text-slate-400">
                      暂无回复内容。若长时间停留在此，请确认后端与 Hermes 上游已启动后重试。
                    </p>
                  ) : null}
                </>
              )}
              {message.role === "assistant" && renderAfterMessage ? renderAfterMessage(message) : null}
            </div>
          );
        })}
    </div>
  );
}

function summarizeFileExecution(
  actions?: FileActionProposal[],
  toolEvents?: AssistantToolEvent[],
) {
  if (!actions?.length && !toolEvents?.length) return null;
  if (actions?.length) return summarizeFileActions(actions);
  return summarizeToolEvents(toolEvents);
}

function summarizeToolEvents(events?: AssistantToolEvent[]) {
  if (!events?.length) return null;
  const running = events.filter((event) => event.status === "running").length;
  const completed = events.filter((event) => event.status === "completed").length;
  const names = events
    .map((event) => event.path || event.label)
    .filter(Boolean)
    .slice(0, 2)
    .join("、");
  if (running > 0) {
    return {
      tone: "working" as const,
      title: `Agent 正在执行 ${running} 项操作`,
      detail: names ? `正在处理 ${names}。` : "正在调用工具。",
      fallbackText: names ? `正在执行：${names}` : "正在执行工具调用。",
    };
  }
  return {
    tone: "success" as const,
    title: "Agent 已完成工具调用",
    detail: names || `共完成 ${completed} 项操作`,
    fallbackText: names ? `已完成：${names}` : "已完成工具调用。",
  };
}

function summarizeFileActions(actions?: FileActionProposal[]) {
  if (!actions?.length) return null;
  const applied = actions.filter((action) => action.status === "applied").length;
  const applying = actions.filter((action) => action.status === "applying").length;
  const failed = actions.filter((action) => action.status === "failed").length;
  const proposed = actions.filter((action) => action.status === "proposed").length;
  const createCount = actions.filter((action) => action.type === "create").length;
  const patchCount = actions.filter((action) => action.type === "patch").length;
  const names = actions
    .map((action) => action.fileName)
    .filter(Boolean)
    .slice(0, 2)
    .join("、");

  if (failed > 0) {
    return {
      tone: "error" as const,
      title: `Agent 文件操作失败 ${failed} 项`,
      detail: names ? `请检查 ${names} 的自动应用结果。` : "请检查自动应用结果。",
      fallbackText: names ? `自动应用失败：${names}` : "自动应用失败，请重试。",
    };
  }
  if (applying > 0) {
    return {
      tone: "working" as const,
      title: `Agent 正在应用 ${applying} 项文件操作`,
      detail: names ? `正在写入 ${names}。` : "正在把修改写回项目文件。",
      fallbackText: names ? `正在自动应用：${names}` : "正在自动应用文件修改。",
    };
  }
  if (applied > 0) {
    const parts: string[] = [];
    if (createCount > 0) parts.push(`新建 ${createCount} 个文件`);
    if (patchCount > 0) parts.push(`修改 ${patchCount} 个文件`);
    return {
      tone: "success" as const,
      title: "Agent 已完成文件操作",
      detail: parts.join("，") || `共完成 ${applied} 项文件操作`,
      fallbackText:
        parts.length > 0
          ? `已自动保存：${parts.join("，")}${names ? `，涉及 ${names}` : ""}。`
          : "已自动完成并保存文件操作。",
    };
  }
  if (proposed > 0) {
    return {
      tone: "working" as const,
      title: `Agent 已生成 ${proposed} 项文件操作`,
      detail: names ? `即将处理 ${names}。` : "正在准备自动应用。",
      fallbackText: names ? `已生成文件操作：${names}` : "已生成文件操作。",
    };
  }
  return {
    tone: "neutral" as const,
    title: "Agent 文件操作已结束",
    detail: names || "本轮包含文件操作。",
    fallbackText: names ? `文件操作已结束：${names}` : "文件操作已结束。",
  };
}

function AgentExecutionPanel({
  summary,
}: {
  summary: NonNullable<ReturnType<typeof summarizeFileActions>>;
}) {
  const toneClass =
    summary.tone === "success"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800/60 dark:bg-emerald-950/30 dark:text-emerald-200"
      : summary.tone === "error"
        ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200"
        : "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-800/60 dark:bg-blue-950/30 dark:text-blue-200";

  return (
    <div className={`mb-3 rounded-xl border px-3 py-2 ${toneClass}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex h-1.5 w-1.5 rounded-full bg-current opacity-80" aria-hidden />
        <p className="text-xs font-semibold">{summary.title}</p>
      </div>
      {summary.detail ? <p className="mt-1 text-xs opacity-90">{summary.detail}</p> : null}
    </div>
  );
}

function UserMessageBubble({ message }: { message: Message }) {
  const excerpts = message.regionExcerpts;
  const prompt =
    message.userPrompt ??
    (excerpts?.length ? splitLegacyUserPrompt(message.content) : message.content);

  if (!excerpts?.length) {
    return <p className="whitespace-pre-wrap text-sm">{prompt}</p>;
  }

  return (
    <div className="space-y-0">
      {prompt ? <p className="whitespace-pre-wrap text-sm">{prompt}</p> : null}
      <div
        className={`space-y-2 ${prompt ? "mt-3 border-t border-white/25 pt-3" : ""}`}
      >
        {excerpts.map((excerpt, index) => (
          <RegionExcerptPreview key={`${excerpt.fileName}-${excerpt.startLine}-${index}`} excerpt={excerpt} />
        ))}
      </div>
    </div>
  );
}

/** 兼容旧消息：从 content 中拆出用户要求（--- 之前） */
function splitLegacyUserPrompt(content: string): string {
  const marker = "\n\n---\n\n";
  const idx = content.indexOf(marker);
  if (idx === -1) return content;
  return content.slice(0, idx).trim();
}

function RegionExcerptPreview({ excerpt }: { excerpt: MessageRegionExcerpt }) {
  return (
    <div className="rounded-lg bg-white/10 px-3 py-2">
      <p className="text-[11px] font-medium text-blue-100">
        {excerpt.fileName} ({excerpt.startLine}-{excerpt.endLine})
      </p>
      <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-blue-50/90">
        {excerpt.text}
      </p>
    </div>
  );
}
