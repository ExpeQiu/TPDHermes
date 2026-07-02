"use client";

import type { AssistantToolEvent } from "@/app/chat/chat-types";
import {
  toolEventDisplayName,
  toolEventEmoji,
} from "@/app/projects/[id]/co-create/co-create-agent-utils";

const PHASE_LABELS: Record<string, string> = {
  co_create_draft: "写稿模式",
  kb_prefetch: "预检索知识库",
  kb_prefetch_timeout: "知识库预检索超时",
  agent_generating: "Agent 生成中",
  agent_waiting_first_token: "等待首 token",
  agent_cold_start: "Agent 冷启动",
  agent_streaming: "流式输出中",
};

type Props = {
  phase?: string;
  toolEvents?: AssistantToolEvent[];
  streaming?: boolean;
};

export function AgentActivityTimeline({ phase, toolEvents = [], streaming }: Props) {
  const phaseLabel = phase ? PHASE_LABELS[phase] ?? phase : null;
  const hasTools = toolEvents.length > 0;
  if (!phaseLabel && !hasTools) return null;

  return (
    <div className="mb-3 space-y-1.5 rounded-xl border border-slate-200 bg-slate-50/90 px-3 py-2 dark:border-slate-700 dark:bg-slate-800/60">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Agent 活动
      </p>
      {phaseLabel ? (
        <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
          {streaming ? (
            <span
              className="inline-flex h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-blue-500 dark:border-slate-600 dark:border-t-blue-400"
              aria-hidden
            />
          ) : (
            <span className="inline-flex h-1.5 w-1.5 rounded-full bg-blue-500" aria-hidden />
          )}
          <span>{phaseLabel}</span>
        </div>
      ) : null}
      {hasTools ? (
        <ul className="space-y-1">
          {toolEvents.map((event) => (
            <ToolEventRow key={event.toolCallId} event={event} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ToolEventRow({ event }: { event: AssistantToolEvent }) {
  const isFileTool = event.toolName === "write_file" || event.toolName === "patch";
  const statusLabel =
    event.status === "completed"
      ? "完成"
      : event.status === "failed"
        ? "失败"
        : "进行中";
  const toneClass =
    event.status === "completed"
      ? "text-emerald-700 dark:text-emerald-300"
      : event.status === "failed"
        ? "text-red-600 dark:text-red-300"
        : "text-blue-700 dark:text-blue-300";

  return (
    <li className="flex items-start gap-2 text-[11px]">
      <span className="shrink-0 opacity-80" aria-hidden>
        {event.emoji || toolEventEmoji(event.toolName)}
      </span>
      <div className="min-w-0 flex-1">
        <span className={`font-medium ${toneClass}`}>
          {toolEventDisplayName(event.toolName)}
        </span>
        <span className="text-slate-400"> · {statusLabel}</span>
        {(event.path || event.label || event.summary) && !isFileTool ? (
          <p className="mt-0.5 truncate text-slate-500 dark:text-slate-400">
            {event.summary || event.path || event.label}
          </p>
        ) : null}
        {isFileTool && (event.path || event.label) ? (
          <p className="mt-0.5 break-all text-slate-500 dark:text-slate-400">
            {event.path || event.label}
          </p>
        ) : null}
      </div>
    </li>
  );
}
